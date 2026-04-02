import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3777', 10),
  mongodbUri: process.env.MONGODB_URI || 'mongodb://localhost:27017/projectshub',
  jwtSecret: process.env.JWT_SECRET || 'default_jwt_secret',
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || '',
    clientSecret: process.env.GITHUB_CLIENT_SECRET || '',
    callbackUrl: process.env.GITHUB_CALLBACK_URL || 'http://localhost:3777/api/auth/github/callback',
  },
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:4567',
  obsidianVaultPath: process.env.OBSIDIAN_VAULT_PATH || '',
};
