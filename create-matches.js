const { ethers } = require('ethers');
require('dotenv').config();

async function createAllMatches() {
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  
  console.log('Wallet:', wallet.address);
  console.log('Contract:', process.env.BETTING_ADDRESS);
  
  const betting = new ethers.Contract(
    process.env.BETTING_ADDRESS,
    [
      "function matchCount() view returns (uint256)",
      "function createMatch(string,string,uint256,uint256) returns (uint256)"
    ],
    wallet
  );
  
  // Check existing
  let count;
  try {
    count = Number(await betting.matchCount());
    console.log('Existing matches:', count);
    if (count > 0) {
      console.log('Matches already exist. Use fresh contract or remove this check.');
      return;
    }
  } catch(e) {
    console.log('Could not check matchCount:', e.message);
  }
  
  // Get matches from API
  const response = await fetch('https://backend-wcup.vercel.app/api/matches');
  const data = await response.json();
  
  const groupMatches = data.matches
    .filter(m => m.round === 'Group Stage')
    .sort((a, b) => a.id - b.id);
  
  console.log(`Found ${groupMatches.length} group matches to create`);
  
  for (let i = 0; i < groupMatches.length; i++) {
    const match = groupMatches[i];
    const betDeadline = match.startTime - 300;
    
    try {
      console.log(`Creating: ${match.homeTeam} vs ${match.awayTeam} (${i+1}/${groupMatches.length})`);
      
      const tx = await betting.createMatch(
        match.homeTeam,
        match.awayTeam,
        match.startTime,
        betDeadline,
        { gasLimit: 300000 }
      );
      
      console.log('TX sent:', tx.hash);
      const receipt = await tx.wait();
      console.log(`✅ Confirmed! Block: ${receipt.blockNumber}`);
      
      // Wait between transactions
      await new Promise(r => setTimeout(r, 3000));
      
    } catch(e) {
      console.log(`❌ Failed: ${e.message?.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  
  console.log('\nDone!');
}

createAllMatches().catch(console.error);