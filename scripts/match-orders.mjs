import { matchOnce } from "./matcher-core.mjs";

const dryRun =
  process.argv.includes("--dry-run") || process.env.MATCHER_DRY_RUN === "true";
const result = await matchOnce({ dryRun });

if (result.matched) {
  console.log("撮合成功：");
  console.log(JSON.stringify(result, null, 2));
} else if (result.dryRun) {
  console.log("发现可撮合候选订单，dry-run 未发链上交易：");
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log("本轮未撮合：");
  console.log(JSON.stringify(result, null, 2));
}
