// npm install js-tiktoken
//
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const enc = new Tiktoken(o200k_base);
const tokens = enc.encode("你好，世界！");

console.log("编码后的token IDs:", tokens);

const decodedText = enc.decode(tokens);
console.log("解码后的文本:", decodedText);

console.log("Token 数量:", tokens.length);
