const { PDFDocument } = require('pdf-lib');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

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

async function downloadPdfFromS3(fileKey) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

async function uploadPdfToS3(pdfBytes, outputKey) {
  const uploadCommand = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
    Body: pdfBytes,
    ContentType: 'application/pdf',
  });
  await s3.send(uploadCommand);

  const downloadCommand = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
  });
  const signedUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 3600 });
  return signedUrl;
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { fileKeys } = body;

    if (!fileKeys || fileKeys.length < 2) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({
          error: 'Please provide at least 2 PDF files to merge'
        })
      };
    }

    const mergedPdf = await PDFDocument.create();

    for (const fileKey of fileKeys) {
      const pdfBuffer = await downloadPdfFromS3(fileKey);
      const pdf = await PDFDocument.load(pdfBuffer);
      const pageIndices = pdf.getPageIndices();
      const copiedPages = await mergedPdf.copyPages(pdf, pageIndices);
      copiedPages.forEach(page => mergedPdf.addPage(page));
    }

    const mergedPdfBytes = await mergedPdf.save();
    const outputKey = 'processed/merged-' + Date.now() + '.pdf';
    const downloadUrl = await uploadPdfToS3(mergedPdfBytes, outputKey);

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        message: 'PDFs merged successfully',
        downloadUrl: downloadUrl,
        outputKey: outputKey
      })
    };

  } catch (error) {
    console.log('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Processing failed',
        detail: error.message
      })
    };
  }
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}