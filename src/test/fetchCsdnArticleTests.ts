import {fetchCsdnArticle} from "../engines/csdn/fetchCsdnArticle.js";

/**
 * Test suite for CSDN article fetching functionality
 */
async function testFetchCsdnArticle() {
  console.log('🔍 Starting CSDN article fetch test...');

  try {
    const url = 'https://blog.csdn.net/weixin_45801664/article/details/149000138';

    console.log(`📝 Fetching article from URL: ${url}`);

    const result = await fetchCsdnArticle(url);

    console.log(`🎉 Article fetched successfully!`);
    console.log(`\n📄 Content preview (first 200 chars):`);
    console.log(`   ${result.content}`);
    console.log(`\n📊 Total content length: ${result.content.length} characters`);

    return result;
  } catch (error) {
    console.error('❌ Test failed:', error);
    if (error instanceof Error) {
      console.error(`   Error message: ${error.message}`);
    }
    return { content: '' };
  }
}

/**
 * Test with an invalid URL to verify error handling
 */
async function testInvalidUrl() {
  console.log('\n🔍 Testing with invalid URL...');

  try {
    const invalidUrl = 'https://blog.csdn.net/invalid_path';

    console.log(`📝 Attempting to fetch from invalid URL: ${invalidUrl}`);

    const result = await fetchCsdnArticle(invalidUrl);
    console.log(`🎉 Result: ${result.content.substring(0, 100)}...`);

    return result;
  } catch (error) {
    console.error('❌ Test failed (expected for invalid URL):', error);
    if (error instanceof Error) {
      console.error(`   Error message: ${error.message}`);
    }
    return { content: '' };
  }
}

/**
 * Run all test cases in sequence
 */
async function runTests() {
  console.log('🧪 Running tests for fetchCsdnArticle function\n');

  await testFetchCsdnArticle();
  // await testInvalidUrl();

  console.log('\n✅ All tests completed');
}

// Execute the test suite
runTests().catch(console.error);
