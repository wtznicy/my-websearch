import { searchJuejin } from '../engines/juejin/index.js';
import { SearchResult } from '../types.js';

async function testJuejin() {
  console.log('🔍 Starting Juejin search test...');

  try {
    const query = 'openwebsearch';
    const maxResults = 30;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchJuejin(query, maxResults);

    console.log(`🎉 Search completed, retrieved ${results.length} results:`);
    if (results.length === 0) {
      console.error('❌ Test failed: no results returned (engine may be blocked or network unavailable)');
      process.exit(1);
    }
    results.forEach((result: SearchResult, index: number) => {
      console.log(`\n${index + 1}. ${result.title}`);
      console.log(`   🔗 ${result.url}`);
      console.log(`   📄 ${result.description.substring(0, 150)}...`);
      console.log(`   👤 Author: ${result.source}`);
    });

    return results;
  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
    return [];
  }
}

// 运行测试
testJuejin()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
