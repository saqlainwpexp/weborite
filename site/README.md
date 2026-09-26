# studio.weborite.com

Static website for Weborite Studio. Upload everything in this folder (including `.htaccess`) to the
subdomain's web root. No build step.

- `index.html`: homepage, features, pricing, FAQ
- `privacy.html`, `terms.html`, `refund.html`: legal pages. The app links to `/privacy` and `/terms`
  (see `shared/legal.ts`); `.htaccess` serves them without the `.html` extension on Apache/LiteSpeed hosts.
- `download/Weborite-Studio-Setup.exe`: upload the installer from `npm run dist` here, renamed.

Before going live, check the prices, the Lemon Squeezy checkout link ("Buy a license") and the contact email.
