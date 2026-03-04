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

async function downloadFromS3(fileKey) {
  const command = new GetObjectCommand({ Bucket: BUCKET_NAME, Key: fileKey });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { fileKeys } = body;

    if (!fileKeys || fileKeys.length === 0) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Please provide at least one image file' })
      };
    }

    const pdfDoc = await PDFDocument.create();

    for (const fileKey of fileKeys) {
      const imageBuffer = await downloadFromS3(fileKey);
      const ext = fileKey.split('.').pop().toLowerCase();

      let image;
      if (ext === 'png') {
        image = await pdfDoc.embedPng(imageBuffer);
      } else {
        image = await pdfDoc.embedJpg(imageBuffer);
      }

      const page = pdfDoc.addPage([image.width, image.height]);
      page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    }

    const pdfBytes = await pdfDoc.save();
    const outputKey = 'processed/document-' + Date.now() + '.pdf';

    await s3.send(new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: outputKey,
      Body: pdfBytes,
      ContentType: 'application/pdf',
    }));

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: BUCKET_NAME, Key: outputKey }),
      { expiresIn: 3600 }
    );

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        message: 'Images converted to PDF successfully',
        downloadUrl,
        pageCount: fileKeys.length
      })
    };

  } catch (error) {
    console.log('Error:', error);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: 'Processing failed', detail: error.message })
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
