const fs = require('fs');
const path = 'c:/Users/UTL_ADMIN/Desktop/Shawn/threadly/bthreadly/src/auth/auth.controller.ts';
let text = fs.readFileSync(path, 'utf8');
text = text.replace("    await this.tokenService.revokeRefreshToken(refreshToken);\r\n    return", "    await this.tokenService.revokeRefreshToken(refreshToken);\r\n\r\n    return");
fs.writeFileSync(path, text);
