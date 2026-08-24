import {searchExa} from "../engines/exa/index.js";

async function testExaSearch() {
  console.log('🔍 Starting Exa search test...');

  try {
    const query = 'websearchmcp';
    const maxResults = 10;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchExa(query, maxResults);

    console.log(`🎉 Search completed, retrieved ${results.length} results:`);
    if (results.length === 0) {
      console.error('❌ Test failed: no results returned (engine may be blocked or network unavailable)');
      process.exit(1);
    }

    results.forEach((result, index) => {
      console.log(`\n${index + 1}. ${result.title}`);
      console.log(`   🔗 ${result.url}`);
      console.log(`   📄 ${result.description.substring(0, 100)}...`);
      console.log(`   🌐 Source: ${result.source}`);
    });

    return results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 未配置 EXA_API_KEY 属于环境配置缺失（确定性错误），显式跳过而非失败
    if (message.includes('EXA_API_KEY')) {
      console.log(`⏭️ SKIPPED: ${message}`);
      process.exit(0);
    }
    console.error('❌ Test failed:', error);
    process.exit(1);
    return [];
  }
}

// Run the test
testExaSearch()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
