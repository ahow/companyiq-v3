
import { Redis } from "ioredis";
import fs from "fs";

async function main() {
  const url = fs.readFileSync("/home/ubuntu/.prod_redis_url", "utf8").trim();
  const redis = new Redis(url);
  
  const keys = await redis.keys("bull:analysis:*");
  console.log("Bull keys found:", keys.length);
  
  // Check specifically for waiting/active/delayed counts
  // BullMQ stores these in sets/lists
  const waiting = await redis.llen("bull:analysis:waiting");
  const active = await redis.zcard("bull:analysis:active");
  const delayed = await redis.zcard("bull:analysis:delayed");
  const completed = await redis.zcard("bull:analysis:completed");
  const failed = await redis.zcard("bull:analysis:failed");

  console.log(`Waiting: ${waiting}`);
  console.log(`Active: ${active}`);
  console.log(`Delayed: ${delayed}`);
  console.log(`Completed: ${completed}`);
  console.log(`Failed: ${failed}`);

  redis.disconnect();
}

main().catch(console.error);
