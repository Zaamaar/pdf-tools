const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Document, Packer, Paragraph, TextRun, HeadingLevel } = require('docx');
const pdfParse = require('pdf-parse');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function downloadFromS3(fileKey) {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { fileKey } = body;
    if (!fileKey) {
      return { statusCode: 400, headers: corsHeaders(), body: JSON.stringify({ error: 'Please provide a PDF file' }) };
    }
    const pdfBuffer = await downloadFromS3(fileKey);
    const pdfData = await pdfParse(pdfBuffer);
    const lines = pdfData.text.split('\n');
    const paragraphs = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { paragraphs.push(new Paragraph({ spacing: { after: 200 } })); continue; }
      const isHeading = trimmed.length < 80 && (trimmed === trimmed.toUpperCase() || /^[A-Z][^.!?]*$/.test(trimmed));
      if (isHeading && trimmed.length > 3) {
        paragraphs.push(new Paragraph({ text: trimmed, heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 200 } }));
      } else {
        paragraphs.push(new Paragraph({ children: [new TextRun({ text: trimmed, size: 24, font: 'Calibri' })], spacing: { after: 160 } }));
      }
    }
    const doc = new Document({ sections: [{ properties: { page: { margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } }, children: paragraphs }] });
    const docxBuffer = await Packer.toBuffer(doc);
    const outputKey = 'processed/document-' + Date.now() + '.docx';
    await s3.send(new PutObjectCommand({ Bucket: BUCKET_NAME, Key: outputKey, Body: docxBuffer, ContentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }));
    const downloadUrl = await getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET_NAME, Key: outputKey }), { expiresIn: 3600 });
    return { statusCode: 200, headers: corsHeaders(), body: JSON.stringify({ message: 'PDF converted to Word successfully', downloadUrl, pageCount: pdfData.numpages }) };
  } catch (error) {
    console.log('Error:', error);
    return { statusCode: 500, headers: corsHeaders(), body: JSON.stringify({ error: 'Processing failed', detail: error.message }) };
  }
};

function corsHeaders() {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
}
