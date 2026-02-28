// ============================================
// MERGE PDF — AWS Lambda Function
// 
// What this function does:
// 1. Receives a list of S3 file keys from the frontend
// 2. Downloads each PDF from S3
// 3. Merges them all into one PDF using pdf-lib
// 4. Uploads the merged PDF back to S3
// 5. Returns a pre-signed download URL to the frontend
// ============================================

// Import pdf-lib — the library that handles all PDF operations
// PDFDocument is the main class we use to create and modify PDFs
const { PDFDocument } = require('pdf-lib');

// Import AWS SDK S3 client and the commands we need
// S3Client — the connection to S3
// GetObjectCommand — downloads a file from S3
// PutObjectCommand — uploads a file to S3
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

// Import the pre-signed URL generator
// This creates temporary download links for processed files
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

// Create an S3 client instance
// This is the object we use to talk to S3
// It automatically uses the IAM role credentials attached to the Lambda function
// No access keys needed — exactly like your VPC project IAM roles
const s3 = new S3Client({ region: process.env.AWS_REGION });

// The bucket name comes from an environment variable
// We never hardcode bucket names — they're configured when deploying
const BUCKET_NAME = process.env.BUCKET_NAME;

// ============================================
// HELPER FUNCTION: streamToBuffer
// 
// When we download a file from S3 it comes back
// as a stream — a continuous flow of data chunks
// rather than one complete piece of data.
// 
// pdf-lib needs the complete file in memory as
// a Buffer (raw bytes) before it can work with it.
// 
// This function collects all the stream chunks
// and assembles them into one complete Buffer.
// ============================================
async function streamToBuffer(stream) {
  // Create an empty array to collect data chunks as they arrive
  const chunks = [];

  // Return a Promise — this wraps the async stream operation
  // so we can use await on it in our main function
  return new Promise((resolve, reject) => {

    // 'data' event fires every time a new chunk of data arrives
    // We push each chunk into our chunks array
    stream.on('data', (chunk) => chunks.push(chunk));

    // 'error' event fires if something goes wrong during download
    // We reject the Promise which causes the calling code to throw an error
    stream.on('error', reject);

    // 'end' event fires when all data has been received
    // Buffer.concat joins all chunks into one complete Buffer
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// ============================================
// HELPER FUNCTION: downloadPdfFromS3
// 
// Downloads a single PDF file from S3 and
// returns it as a Buffer (raw bytes in memory)
// ============================================
async function downloadPdfFromS3(fileKey) {
  // Create a GetObject command — this tells S3 which file we want
  const command = new GetObjectCommand({
    Bucket: BUCKET_NAME,  // which bucket
    Key: fileKey,          // which file inside the bucket
  });

  // Send the command to S3 and wait for the response
  // response.Body is the file data as a stream
  const response = await s3.send(command);

  // Convert the stream to a Buffer using our helper function
  // await pauses execution here until the entire file is downloaded
  const buffer = await streamToBuffer(response.Body);

  return buffer;
}

// ============================================
// HELPER FUNCTION: uploadPdfToS3
// 
// Uploads a processed PDF to S3 and returns
// a pre-signed URL the frontend can use to
// download the file directly from S3
// ============================================
async function uploadPdfToS3(pdfBytes, outputKey) {
  // Create a PutObject command — this uploads a file to S3
  const uploadCommand = new PutObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,              // the filename/path in S3
    Body: pdfBytes,              // the actual file data
    ContentType: 'application/pdf',  // tells S3 this is a PDF file
  });

  // Upload the file and wait for it to complete
  await s3.send(uploadCommand);

  // Now create a pre-signed URL for downloading
  // This is a temporary link that expires after 1 hour (3600 seconds)
  // The frontend uses this URL to let the user download the merged PDF
  const downloadCommand = new GetObjectCommand({
    Bucket: BUCKET_NAME,
    Key: outputKey,
  });

  // getSignedUrl generates the temporary download URL
  // expiresIn: 3600 means the link expires after 3600 seconds (1 hour)
  const signedUrl = await getSignedUrl(s3, downloadCommand, { expiresIn: 3600 });

  return signedUrl;
}

// ============================================
// MAIN HANDLER — this is what Lambda calls
// 
// Every Lambda function has a handler — the
// entry point that AWS calls when the function
// is triggered. It receives an event object
// containing the data sent from the frontend.
// ============================================
exports.handler = async (event) => {

  // Lambda receives all data inside the event object
  // The frontend sends a JSON body with the list of file keys
  // event.body is a JSON string so we parse it into an object
  const body = JSON.parse(event.body);

  // fileKeys is an array of S3 keys — the paths to the uploaded PDFs
  // Example: ['uploads/file1.pdf', 'uploads/file2.pdf']
  const { fileKeys } = body;

  // Basic validation — make sure we received at least 2 files
  // You can't merge fewer than 2 PDFs
  if (!fileKeys || fileKeys.length < 2) {
    return {
      statusCode: 400,
      headers: corsHeaders(),
      body: JSON.stringify({
        error: 'Please provide at least 2 PDF files to merge'
      })
    };
  }

  // Create a new empty PDF document
  // This will become our merged output document
  const mergedPdf = await PDFDocument.create();

  // Loop through each file key and merge its pages into mergedPdf
  // We use a for...of loop instead of forEach because
  // forEach doesn't work properly with async/await
  for (const fileKey of fileKeys) {

    // Download this PDF from S3 as a Buffer
    const pdfBuffer = await downloadPdfFromS3(fileKey);

    // Load the Buffer into pdf-lib so we can read its pages
    // PDFDocument.load() parses the raw bytes into a PDF object
    const pdf = await PDFDocument.load(pdfBuffer);

    // Get the page indices — an array like [0, 1, 2, 3] for a 4 page PDF
    // pdf.getPageCount() returns how many pages the PDF has
    const pageIndices = pdf.getPageIndices();

    // copyPages copies the specified pages FROM this PDF INTO mergedPdf
    // This is the core merge operation
    const copiedPages = await mergedPdf.copyPages(pdf, pageIndices);

    // Add each copied page to the merged document in order
    copiedPages.forEach(page => mergedPdf.addPage(page));
  }

  // Save the merged PDF as raw bytes (a Uint8Array)
  // This is the final merged file ready to be uploaded
  const mergedPdfBytes = await mergedPdf.save();

  // Generate a unique output filename using the current timestamp
  // This prevents filename collisions if multiple users merge at the same time
  const outputKey = `processed/merged-${Date.now()}.pdf`;

  // Upload the merged PDF to S3 and get a pre-signed download URL
  const downloadUrl = await uploadPdfToS3(mergedPdfBytes, outputKey);

  // Return a success response to the frontend
  // statusCode 200 means success
  // body contains the download URL the frontend uses
  return {
    statusCode: 200,
    headers: corsHeaders(),
    body: JSON.stringify({
      message: 'PDFs merged successfully',
      downloadUrl: downloadUrl,
      outputKey: outputKey
    })
  };
};

// ============================================
// HELPER FUNCTION: corsHeaders
//
// CORS stands for Cross-Origin Resource Sharing
// Browsers block API requests from one domain
// to another domain by default for security.
// 
// Our frontend is on S3 (one domain) and our
// Lambda API is on API Gateway (different domain)
// so we must include these headers in every
// response to tell the browser the request is safe.
// ============================================
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
}
<<<<<<< HEAD
=======
        ▼
Frontend shows download button using that URL
>>>>>>> 533e5eab436abbe58902579763201199f426c713
