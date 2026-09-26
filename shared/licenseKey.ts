/**
 * Where the app checks license keys, and the public key of that server's signing key pair.
 * After uploading site/license/ and setting its password, copy the public key from the admin page
 * (studio.weborite.com/license/) into LICENSE_PUBLIC_KEY. A customer build refuses to build without it.
 */
export const LICENSE_API = "https://studio.weborite.com/license/v1";
export const LICENSE_PUBLIC_KEY = "";
