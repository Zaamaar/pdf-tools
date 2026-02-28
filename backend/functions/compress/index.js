// ============================================
// COMPRESS PDF — AWS Lambda Function
//
// What this function does:
// 1. Receives one S3 file key from the frontend
// 2. Downloads the PDF from S3
// 3. Compresses it using pdf-lib by removing
//    redundant data and rewriting the structure
// 4. Uploads the compressed PDF back to S3
// 5. Returns a pre-signed download URL and
//    reports how much space was saved
// ============================================

const { PDFDocument } = require('pdf-lib');
const { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

// ============================================
// streamToBuffer — same helper as before
// ============================================
async function streamToBuffer(stream) {
  const chunks = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ============================================
// downloadPdfFromS3 — same helper as before
// Returns the file as a Buffer AND its size
// in bytes so we can calculate savings later
// ============================================
async function downloadPdfFromS3(fileKey) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });

  const response = await s3.send(command);
  const buffer = await streamToBuffer(response.Body);

  // response.ContentLength is the file size in bytes
  // We return both the buffer and the original size
  // so the handler can calculate the compression ratio
  return {
    buffer,
    originalSize: response.ContentLength
  };
}

// ============================================
// compressPdf
//
// This is the core compression function.
//
// pdf-lib compresses by loading the PDF and
// saving it with the useObjectStreams option.
//
// What useObjectStreams does:
// PDFs store their internal data as "objects"
// (pages, fonts, images, metadata etc).
// By default these objects are stored individually.
// useObjectStreams packs multiple objects together
// into compressed streams — significantly reducing
// file size especially for PDFs with lots of text,
// metadata, or complex structure.
//
// Important honesty: pdf-lib is not as aggressive
// as tools like Ghostscript for image compression.
// For Phase 3 we can add sharper compression using
// AWS Lambda layers with Ghostscript. For now this
// handles structural compression which works well
// on text-heavy PDFs.
// ============================================
async function compressPdf(pdfBuffer) {

  // Load the PDF into pdf-lib
  const pdf = await PDFDocument.load(pdfBuffer, {
    // ignoreEncryption allows processing of
    // password-protected PDFs without a password
    // for basic compression operations
    ignoreEncryption: true
  });

  // Save with compression enabled
  // useObjectStreams: true — packs objects into
  // compressed streams (the main compression step)
  // addDefaultPage: false — don't add an extra blank page
  const compressedBytes = await pdf.save({
    useObjectStreams: true,
  });

  return compressedBytes;
}

// ============================================
// uploadCompressedPdfToS3
// Same pattern as merge and split
// ============================================
async function uploadCompressedPdfToS3(pdfBytes, outputKey) {
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

// ============================================
// formatBytes
//
// Converts raw bytes into a human readable
// string like "2.4 MB" or "340 KB"
// This is what we show the user in the result
// ============================================
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ============================================
// MAIN HANDLER
// ============================================
exports.handler = async (event) => {

  const body = JSON.parse(event.body);
  const { fileKey } = body;

  if (!fileKey) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Please provide a PDF file to compress'
      })
    };
  }

  // Download the PDF and get its original size
  const { buffer: pdfBuffer, originalSize } = await downloadPdfFromS3(fileKey);

  // Run compression
  const compressedBytes = await compressPdf(pdfBuffer);

  // Calculate how much we saved
  // compressedBytes.length is the size of the
  // compressed file in bytes
  const compressedSize = compressedBytes.length;

  // Calculate the percentage saved
  // Math.round rounds to the nearest integer
  const savedPercent = Math.round((1 - compressedSize / originalSize) * 100);

  // Generate unique output key
  const outputKey = `processed/compressed-${Date.now()}.pdf`;

  // Upload and get download URL
  const downloadUrl = await uploadCompressedPdfToS3(compressedBytes, outputKey);

  // Return result with size comparison
  // The frontend uses these numbers to show
  // "Reduced from 4.2 MB to 1.8 MB — saved 57%"
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      message: 'PDF compressed successfully',
      downloadUrl,
      outputKey,
      originalSize: formatBytes(originalSize),
      compressedSize: formatBytes(compressedSize),
      savedPercent: savedPercent > 0 ? savedPercent : 0,
      // savedPercent could theoretically be negative
      // if the compressed file is somehow larger
      // We clamp it to 0 in that case
    })
  };
};

// ============================================
// corsHeaders — same as all other functions
// ============================================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}