import { loadEnv } from "../src/env.js";

const env = loadEnv();
console.log("FAST_BASE_URL:", env.FAST_BASE_URL);
console.log("FAST_MODEL:", env.FAST_MODEL);
console.log("STRONG_BASE_URL:", env.STRONG_BASE_URL);
console.log("STRONG_MODEL:", env.STRONG_MODEL);
console.log("FAST_API_KEY set:", env.FAST_API_KEY.length > 0);
console.log("STRONG_API_KEY set:", env.STRONG_API_KEY.length > 0);
