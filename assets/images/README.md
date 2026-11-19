# FIRE COUNSEL image assets

- `fire-counsel-brand.jpg` — optimized local copy of the gavel-and-flame artwork supplied by the site owner (1440 × 960, landscape 3:2). Shared page branding uses `branding.css` to show the complete image above the centered wordmark; use `object-fit: contain`, not a square crop. The source artwork and the separate square PWA icons are unchanged.
- `pexels-law-judge.jpg` — photo by Katrin Bolovtsova, Pexels photo 6077294: <https://www.pexels.com/photo/a-woman-sitting-at-the-table-6077294/>. Pexels license: <https://www.pexels.com/license/>.
- `pexels-law-student.jpg` — photo by Ludovic Delot, Pexels photo 16420237: <https://www.pexels.com/photo/a-student-sitting-in-a-library-and-with-a-laptop-and-studying-16420237/>. Pexels license: <https://www.pexels.com/license/>.

The Pexels images are stored locally so the homepage and offline app shell do not depend on third-party image requests. The JSON page content stores local paths and descriptive alt text; replacing a photo in this preview does not upload it to Firebase.
