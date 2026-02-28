// ============================================
// ROTATE PDF — AWS Lambda Function
//
// What this function does:
// 1. Receives one S3 file key and a rotation
//    angle from the frontend
// 2. Downloads the PDF from S3
// 3. Rotates every page by the specified angle
// 4. Uploads the rotated PDF back to S3
// 5. Returns a pre-signed download URL
//
// Supported rotation angles: 90, -90, 180
// 90  = clockwise
// -90 = counter-clockwise
// 180 = upside down
// ============================================

const { PDFDocument, degrees } = require('pdf-lib');

// degrees is a helper from pdf-lib that converts
// a plain number into a pdf-lib rotation object
// pdf-lib needs rotations in its own format
// degrees(90) converts the number 90 into that format

const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.BUCKET_NAME;

// ============================================
// streamToBuffer — same helper as all functions
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
// downloadPdfFromS3 — same helper as all functions
// ============================================
async function downloadPdfFromS3(fileKey) {
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: fileKey,
  });
  const response = await s3.send(command);
  return await streamToBuffer(response.Body);
}

// ============================================
// uploadRotatedPdfToS3 — same pattern as all functions
// ============================================
async function uploadRotatedPdfToS3(pdfBytes, outputKey) {
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
// validateRotation
//
// Checks that the rotation angle sent by the
// frontend is one of the three valid options.
//
// We never trust data coming from the frontend
// — always validate on the backend. A user could
// send any value by manipulating the request.
// Validating server-side prevents unexpected
// behaviour inside pdf-lib.
// ============================================
function validateRotation(angle) {
  const validAngles = [90, -90, 180];
  return validAngles.includes(Number(angle));
}

// ============================================
// MAIN HANDLER
// ============================================
exports.handler = async (event) => {

  const body = JSON.parse(event.body);

  // The frontend sends two pieces of data:
  // fileKey — the S3 path to the uploaded PDF
  // rotation — the angle to rotate (90, -90, or 180)
  const { fileKey, rotation } = body;

  // Validate file key
  if (!fileKey) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Please provide a PDF file to rotate'
      })
    };
  }

  // Validate rotation angle
  if (!validateRotation(rotation)) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Invalid rotation. Must be 90, -90, or 180 degrees'
      })
    };
  }

  // Convert rotation to a number in case it
  // arrived as a string from the frontend
  // Number('90') → 90
  const rotationAngle = Number(rotation);

  // Download the PDF from S3
  const pdfBuffer = await downloadPdfFromS3(fileKey);

  // Load into pdf-lib
  const pdf = await PDFDocument.load(pdfBuffer);

  // Get all pages as an array
  // getPages() returns an array of page objects
  // we can manipulate individually
  const pages = pdf.getPages();

  // Loop through every page and apply rotation
  pages.forEach(page => {

    // getRotation() returns the page's CURRENT rotation
    // as a pdf-lib rotation object
    // .angle extracts the number from that object
    // Example: if page is already rotated 90 degrees
    // currentRotation will be 90
    const currentRotation = page.getRotation().angle;

    // Calculate the new rotation by adding the
    // requested rotation to the current rotation
    // This handles pages that are already rotated
    // Example: page at 90 + user requests 90 = 180
    // Without this a page already at 90 degrees
    // would be reset to just the requested angle
    // instead of accumulating correctly
    const newRotation = currentRotation + rotationAngle;

    // Apply the new rotation using pdf-lib's degrees() helper
    // degrees() converts our plain number into
    // the format pdf-lib expects for rotations
    page.setRotation(degrees(newRotation));
  });

  // Save the rotated PDF
  const rotatedPdfBytes = await pdf.save();

  // Generate unique output key
  const outputKey = `processed/rotated-${Date.now()}.pdf`;

  // Upload and get download URL
  const downloadUrl = await uploadRotatedPdfToS3(rotatedPdfBytes, outputKey);

  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      message: `PDF rotated ${rotationAngle} degrees successfully`,
      downloadUrl,
      outputKey,
      pageCount: pages.length,
      rotation: rotationAngle
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