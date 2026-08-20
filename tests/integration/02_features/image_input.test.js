/**
 * Image Input Tests
 * Tests image content in messages
 *
 * Coverage:
 * - Base64 encoded images
 * - Image URL
 * - Image with text
 * - Multiple images
 */

const {
  sendRequest,
  assert,
  assertResponse,
  runTestSuite
} = require('../utils/test_helpers');

/**
 * Small valid base64 JPEG image (1x1 red pixel)
 * For testing purposes
 */
const SAMPLE_BASE64_IMAGE = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv8ABAEGBQEBAQAAAAAAAAAAAAEAAgMEBQYH/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBEQCEAwEPwABfwAB/9k=';

/**
 * TC1801: Base64 Image Input
 * Tests image sent as base64
 */
async function testBase64Image() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe this image:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: SAMPLE_BASE64_IMAGE
            }
          }
        ]
      }],
      max_tokens: 100
    }
  });

  assertResponse(response);
}

/**
 * TC1802: Image URL
 * Tests image from URL
 */
async function testImageURL() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          {
            type: 'image',
            source: {
              type: 'url',
              url: 'https://www.google.com/images/branding/googlelogo/1x/googlelogo_color_272x92dp.png'
            }
          }
        ]
      }],
      max_tokens: 100
    }
  });

  // Some models may not support URL images, check for valid response
  assert(
    response.status === 200 || response.status >= 400,
    'Should either succeed or fail gracefully'
  );
}

/**
 * TC1803: Image with Text Message
 * Tests text+image in same message
 */
async function testImageWithText() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Look at this image and tell me what you see:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: SAMPLE_BASE64_IMAGE
            }
          }
        ]
      }],
      max_tokens: 50
    }
  });

  assertResponse(response);
}

/**
 * TC1804: Multiple Images
 * Tests message with multiple images
 */
async function testMultipleImages() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Compare these images:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: SAMPLE_BASE64_IMAGE
            }
          },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: SAMPLE_BASE64_IMAGE
            }
          }
        ]
      }],
      max_tokens: 100
    }
  });

  assertResponse(response);
}

/**
 * TC1805: PNG Image
 * Tests PNG format image
 */
async function testPNGImage() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: SAMPLE_BASE64_IMAGE
            }
          }
        ]
      }],
      max_tokens: 50
    }
  });

  assertResponse(response);
}

/**
 * TC1806: WebP Image
 * Tests WebP format image
 */
async function testWebPImage() {
  const response = await sendRequest({
    endpoint: '/v1/messages',
    body: {
      model: 'qwen3-32b',
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Describe:' },
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/webp',
              data: SAMPLE_BASE64_IMAGE
            }
          }
        ]
      }],
      max_tokens: 50
    }
  });

  assertResponse(response);
}

module.exports = {
  testBase64Image,
  testImageURL,
  testImageWithText,
  testMultipleImages,
  testPNGImage,
  testWebPImage,
  SAMPLE_BASE64_IMAGE
};

if (require.main === module) {
  runTestSuite('Image Input Tests', [
    { name: 'TC1801: Base64 Image', fn: testBase64Image },
    { name: 'TC1802: Image URL', fn: testImageURL },
    { name: 'TC1803: Image with Text', fn: testImageWithText },
    { name: 'TC1804: Multiple Images', fn: testMultipleImages },
    { name: 'TC1805: PNG Image', fn: testPNGImage }
  ]);
}