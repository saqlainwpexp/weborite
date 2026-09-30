# studio.weborite.com

Static website for Weborite Studio plus the license service. Upload everything in this folder, including the
hidden `.htaccess` files, to the subdomain's web root. No build step. Needs PHP 8.1+ with the `pdo_sqlite` and
`sodium` extensions (standard on Hostinger).

- `index.html`: homepage, features, pricing, FAQ
- `buy.html`: purchase page. Orders go to `license/order.php`, are listed on the license admin page and emailed to
  `NOTIFY_EMAIL` (set in `license/lib.php`, default hello@weborite.com). The customer gets a confirmation email.
- `demo.html`: free demo page with the download and install steps
- `site.js`: feature tabs, carousels and the order form
- `privacy.html`, `terms.html`, `refund.html`: legal pages. The app links to `/privacy` and `/terms`
  (see `shared/legal.ts`). `.htaccess` gives every page a clean address (`/buy`, `/demo`, `/privacy`…) and
  redirects the old `.html` addresses to them.
- `download/Weborite-Studio-Setup.exe`: upload the installer from `npm run dist` here, renamed.
- `license/`: the license service.

## License service

1. Upload, then open https://studio.weborite.com/license/ straight away and choose the admin password.
2. Copy the **App public key** from the bottom of that page into `LICENSE_PUBLIC_KEY` in
   `shared/licenseKey.ts`, commit it, and build the installer (`npm run dist`). A customer build refuses to
   build without it.
3. To sell: new orders appear at the top of the admin page (and in your inbox). Send the invoice, click
   **Mark invoiced**, and once paid click **Create license**: the form is filled in from the order, and the
   email to send the key is drafted for you. Emails use PHP's mail(), which Hostinger supports; create the
   hello@weborite.com mailbox so replies reach you.

The app talks to `license/v1/licenses/{activate,validate,deactivate}` and only trusts answers signed with the
server's private key, which never leaves `license/data/`. The database is `license/data/licenses.sqlite`
(the web can't reach that folder). Download it from time to time as a backup. If you lose it, every
issued key stops working, and a new key pair means a new installer.
