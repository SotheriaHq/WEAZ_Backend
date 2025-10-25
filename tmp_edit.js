const fs = require('fs');
const path = 'c:/Users/UTL_ADMIN/Desktop/Shawn/threadly/bthreadly/src/auth/helper/general.helper.ts';
const text = fs.readFileSync(path, 'utf8');
console.log(text.endsWith('\n'));
