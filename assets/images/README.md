# FIRE COUNSEL image assets

- `fire-counsel-flame.png` — the flame-in-hexagon logo supplied by the owner on 19 November 2026 (`Screenshot_20261118-235318.png`). Only the surrounding black screenshot margin was trimmed/made transparent; the artwork itself is retained (135 × 161). All page logos, favicon and both PWA icons use this artwork; the old gavel image was removed. Use `object-fit: contain`. The AI welcome animates a masked copy of this same flame plus embers, without moving the hexagon; reduced-motion users see the still logo. Legacy bundled-logo paths in published/cached content resolve to this new asset locally, with no Firebase publication.
- `pexels-law-judge.jpg` — photo by Katrin Bolovtsova, Pexels photo 6077294: <https://www.pexels.com/photo/a-woman-sitting-at-the-table-6077294/>. Pexels license: <https://www.pexels.com/license/>.
- `pexels-law-student.jpg` — photo by Ludovic Delot, Pexels photo 16420237: <https://www.pexels.com/photo/a-student-sitting-in-a-library-and-with-a-laptop-and-studying-16420237/>. Pexels license: <https://www.pexels.com/license/>.

The Pexels images are stored locally so the homepage and offline app shell do not depend on third-party image requests. The JSON page content stores local paths and descriptive alt text; replacing a photo in this preview does not upload it to Firebase.
