const { ethers } = require('ethers');
require('dotenv').config();
async function verify() {
  const betting = new ethers.Contract(
    process.env.BETTING_ADDRESS,
    ['function matchCount() view returns (uint256)'],
    new ethers.JsonRpcProvider('https://mainnet.base.org')
  );
  const count = Number(await betting.matchCount());
  console.log('On-chain matches:', count);
  console.log(count === 70 ? '✅ PERFECT!' : '⚠️ Check count');
}
verify();