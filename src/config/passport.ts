import passport from 'passport';
import { Strategy as GitHubStrategy } from 'passport-github2';
import { config } from './index';
import { AuthService } from '../services/auth.service';

const authService = new AuthService();

export function configurePassport(): void {
  if (!config.github.clientId || !config.github.clientSecret) {
    console.warn('GitHub OAuth credentials not configured. GitHub login will not work.');
    return;
  }

  passport.use(
    new GitHubStrategy(
      {
        clientID: config.github.clientId,
        clientSecret: config.github.clientSecret,
        callbackURL: config.github.callbackUrl,
      },
      async (
        accessToken: string,
        _refreshToken: string,
        profile: any,
        done: (err: any, user?: any) => void
      ) => {
        try {
          const user = await authService.findOrCreateUser({
            githubId: profile.id,
            username: profile.username || profile.displayName,
            displayName: profile.displayName || '',
            avatarUrl: profile.photos?.[0]?.value || '',
            accessToken,
          });
          done(null, user);
        } catch (error) {
          done(error);
        }
      }
    )
  );

  passport.serializeUser((user: any, done) => {
    done(null, user._id);
  });

  passport.deserializeUser(async (id: string, done) => {
    try {
      const user = await authService.findUserById(id);
      done(null, user);
    } catch (error) {
      done(error);
    }
  });
}
