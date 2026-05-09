// Auto-generated helper for Claude Code agents
// Usage: node scripts/write-file.js <filepath> <content>
// Or pipe content: echo "content" | node scripts/write-file.js <filepath>
const fs = require('fs');
const path = require('path');

const filePath = process.argv[2];
if (!filePath) { console.error('Usage: node scripts/write-file.js <filepath> [content]'); process.exit(1); }

const absPath = path.resolve(filePath);

// Content from args or stdin
let content = process.argv.slice(3).join(' ');
if (!content && !process.stdin.isTTY) {
  content = require('fs').readFileSync('/dev/stdin', 'utf8');
}

fs.mkdirSync(path.dirname(absPath), { recursive: true });
fs.writeFileSync(absPath, content, 'utf8');
console.log('Written: ' + absPath + ' (' + content.length + ' bytes)');
