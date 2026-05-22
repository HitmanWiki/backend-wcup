const { ethers } = require('ethers');
async function check() {
  const betting = new ethers.Contract(
    '0x447C7DCc564DA5A7F167E50619513137042b1367',
    ['function matchCount() view returns (uint256)', 'function getMatch(uint256) view returns (tuple(string,string,uint256,uint256,uint8,bool,uint256,uint256,uint256,uint256))'],
    new ethers.JsonRpcProvider('https://base-mainnet.g.alchemy.com/v2/tmYsnJzVHFkg-7jqyLA0G5jbGe4PSsYR')
  );
  const count = Number(await betting.matchCount());
  console.log('Total on-chain:', count);
  
  // Show first 5 and last 5
  for (let i = 0; i < Math.min(5, count); i++) {
    const m = await betting.getMatch(i);
    console.log(`Match ${i}: ${m[0]} vs ${m[1]}`);
  }
  console.log('...');
  for (let i = Math.max(0, count-5); i < count; i++) {
    const m = await betting.getMatch(i);
    console.log(`Match ${i}: ${m[0]} vs ${m[1]}`);
  }
}
check();
