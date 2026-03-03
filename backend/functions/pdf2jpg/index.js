const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const archiver = require('archiver');
const { createCanvas } = require('@napi-rs/canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const { PassThrough } = require('stream');

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
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

async function renderPageToJpg(page) {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const context = canvas.getContext('2d');

  context.fillStyle = 'white';
  context.fillRect(0, 0, viewport.width, viewport.height);

  await page.render({
    canvasContext: context,
    viewport: viewport
  }).promise;

  return canvas.toBuffer('image/jpeg');
}

async function createZipBuffer(files) {
  return new Promise((resolve, reject) => {
    const archive = archiver('zip', { zlib: { level: 6 } });
    const passthrough = new PassThrough();
    const chunks = [];

    passthrough.on('data', chunk => chunks.push(chunk));
    passthrough.on('end', () => resolve(Buffer.concat(chunks)));
    passthrough.on('error', reject);

    archive.pipe(passthrough);
    files.forEach(file => archive.append(file.buffer, { name: file.name }));
    archive.finalize();
  });
}

async function uploadToS3(buffer, outputKey, contentType) {
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
    Body: buffer,
    ContentType: contentType,
  }));

  return await getSignedUrl(s3, new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
  }), { expiresIn: 3600 });
}

exports.handler = async (event) => {
  try {
    const body = JSON.parse(event.body);
    const { fileKey } = body;

    if (!fileKey) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: 'Please provide a PDF file' })
      };
    }

    const pdfBuffer = await downloadFromS3(fileKey);
    const pdfData = new Uint8Array(pdfBuffer);
    const pdf = await pdfjsLib.getDocument({ data: pdfData }).promise;
    const pageCount = pdf.numPages;

    const jpgFiles = [];
    for (let i = 1; i <= pageCount; i++) {
      const page = await pdf.getPage(i);
      const jpgBuffer = await renderPageToJpg(page);
      jpgFiles.push({
        name: 'page-' + i + '.jpg',
        buffer: jpgBuffer
      });
    }

    let downloadUrl;
    let fileName;

    if (pageCount === 1) {
      const outputKey = 'processed/page-' + Date.now() + '.jpg';
      downloadUrl = await uploadToS3(jpgFiles[0].buffer, outputKey, 'image/jpeg');
      fileName = 'page.jpg';
    } else {
      const zipBuffer = await createZipBuffer(jpgFiles);
      const outputKey = 'processed/images-' + Date.now() + '.zip';
      downloadUrl = await uploadToS3(zipBuffer, outputKey, 'application/zip');
      fileName = 'images.zip';
    }

    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        message: 'PDF converted to JPG successfully',
        downloadUrl,
        fileName,
        pageCount
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