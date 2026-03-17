// inspect-db.js
const sqlite3 = require('sqlite3').verbose();

const db = new sqlite3.Database('./worldcup.db');

db.serialize(() => {
  // Get list of tables
  db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, tables) => {
    if (err) {
      console.error("Error:", err);
    } else {
      console.log("\n📋 Tables in database:");
      tables.forEach(table => {
        console.log(`   - ${table.name}`);
      });
    }
  });

  // Get schema of matches table if it exists
  db.all("SELECT sql FROM sqlite_master WHERE type='table' AND name='matches';", (err, schema) => {
    if (err) {
      console.error("Error:", err);
    } else if (schema.length > 0) {
      console.log("\n📝 Schema of 'matches' table:");
      console.log(schema[0].sql);
      
      // Get sample data
      db.all("SELECT * FROM matches LIMIT 1;", (err, rows) => {
        if (err) {
          console.error("Error getting sample:", err);
        } else if (rows.length > 0) {
          console.log("\n✅ Sample row:");
          console.log(rows[0]);
        } else {
          console.log("\n⚠️ No data in matches table");
        }
      });
    } else {
      console.log("\n❌ No 'matches' table found!");
      
      // Show all tables if matches doesn't exist
      db.all("SELECT name FROM sqlite_master WHERE type='table';", (err, tables) => {
        if (tables && tables.length > 0) {
          console.log("\n📋 Available tables:");
          tables.forEach(t => console.log(`   - ${t.name}`));
        }
      });
    }
  });
});

setTimeout(() => db.close(), 1000);