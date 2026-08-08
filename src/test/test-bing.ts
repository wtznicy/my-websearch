import { searchBing } from '../engines/bing/index.js';

async function testBingSearch() {
  console.log('🔍 Starting Bing search test...');

  try {
    const query = 'websearchmcp';
    const maxResults = 10;

    console.log(`📝 Search query: ${query}`);
    console.log(`📊 Maximum results: ${maxResults}`);

    const results = await searchBing(query, maxResults);

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
    console.error('❌ Test failed:', error);
    process.exit(1);
    return [];
  }
}

async function main(): Promise<void> {
  await testBingSearch();
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
