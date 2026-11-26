# Counsel Working Station — admin document desk

Open **Admin Studio → Upload documents → Counsel Working Station**. The adjacent **Classic upload** tab keeps the existing uploader, recent uploads, original-file downloads, review editor and structured case/past-question imports. No existing material or version is deleted by this addition.

## Workflow

1. Sign in with the existing Google administrator account. Every station API request independently verifies the revoked-token/provider checks and the `admin: true` claim; a browser state or role field cannot authorize it.
2. Attach one **PDF, TXT, JPG, PNG or WEBP** document, or paste source text. Choose **Extract only**, **Clean & correct**, **Format document**, or **My instructions**. Enter the requested processing instructions in the chat-style composer.
3. Processing runs as a background job. Digital PDF/TXT extraction is local and makes no AI call. Scan OCR uses the **admin** Gemini key (or the existing optional OCR.space fallback). Correction/formatting uses **Cloudflare Workers AI** first in Auto mode, then the separate admin Gemini provider if necessary. An explicitly selected text provider does not silently switch to the other one.
4. Read and edit the resulting text, compare it with the source text, and give follow-up instructions. Follow-ups send the current edited text rather than uploading/OCR-reading the PDF again. Missing-page/truncation warnings carry forward to follow-up drafts. Long documents are processed in numbered sections, not one global reasoning pass; check transitions and use smaller sections for instructions requiring whole-document context.
5. **Download .txt** at any time after processing. No document, original PDF, chat history, or library text is persisted to Neon by the processing step.
6. Choose the title, optional course and material type, or choose **New version of a material**. Check the explicit review approval. An incomplete result needs an additional acknowledgment. Editing the text/destination revokes prior approval.
7. Click **Approve & save to Neon**. The API saves the reviewed UTF-8 TXT, material/version and page-numbered searchable chunks together in **one transaction**. New materials default to **draft/pending**, not published. The separate publication checkbox is an explicit choice. A new version preserves earlier versions and follows the existing material's visibility; if that material is already published, the new version can be used immediately by student AI.

The station imports reviewed documents as materials (including case-judgment or past-question *text*) or material versions. It deliberately does not run another model to invent structured case/exam fields after approval. Use the retained Classic uploader for structured `legal_cases` / `past_questions` imports and verify those records separately.

## Configure separate resources privately

Set these in the environment of the **API service that serves this website**, not in browser JavaScript, site JSON, prompts, Neon rows or GitHub-only secrets. In Render, use that service's **Environment → Save and deploy** and confirm the deployment is Live. Existing linked environment groups work; avoid conflicting blank/stale service-level overrides.

| Setting | Purpose |
| --- | --- |
| `GEMINI_API_KEY` | Existing **student** Fire Counsel AI credential. Kept unchanged. Never a document-processing fallback. |
| `ADMIN_GEMINI_API_KEY` | A **different** Gemini key for admin document processing, scan OCR and the retained admin extraction/import helpers. Reusing the identical student key is refused. |
| `ADMIN_GEMINI_MODEL` | Optional admin model ID available to the admin project; default `gemini-flash-latest`. Independent of student `GEMINI_MODELS`. |
| `ADMIN_CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID, 32 hexadecimal characters. Not a token, Worker URL or database URL. |
| `ADMIN_CLOUDFLARE_API_TOKEN` | Secret API token authorized to run Workers AI for that account. |
| `ADMIN_CLOUDFLARE_MODEL` | Optional Workers AI text model; default `@cf/meta/llama-3.3-70b-instruct-fp8-fast`. Choose a model actually available to the account. |
| `ADMIN_AI_TIMEOUT_MS` | Optional per-provider deadline; default 90 seconds, clamped to 5–240 seconds. |
| `DATABASE_URL` | Existing Neon PostgreSQL connection string for approved saves. This is not the management `NEON_API_KEY` used by the PR-preview workflow. |
| `OCR_SPACE_API_KEY` | Existing optional fallback for small scans. Its free-plan file/page limits still apply. |

**A new key is not a new quota.** Gemini quotas/billing can be project-scoped, so use a **separate Google AI Studio/Cloud project** for independent admin quota. Two keys from one project may still compete for the same allowance. Cloudflare quota/billing similarly belongs to the configured Cloudflare account. This change separates workload routing; it does not promise free usage or reduce the number of calls required for a scanned document.

### Gemini

1. In Google AI Studio, select/create the intended **separate admin project** and create its API key.
2. Set `ADMIN_GEMINI_API_KEY` privately in the running API service. Leave the old student `GEMINI_API_KEY` in place.
3. Choose an available model with `ADMIN_GEMINI_MODEL` if the default alias is not available to that project. Review provider billing, quotas, document handling and regional availability.
4. Deploy and process a disposable small scan. The provider status is only a presence check, not proof that a key/model works live.

### Cloudflare Workers AI

This implementation uses the **Cloudflare Workers AI REST API**, not an arbitrary custom Worker endpoint. No custom Worker deployment or browser-visible Cloudflare token is required.

1. In the Cloudflare dashboard, open the intended account and copy its **Account ID**.
2. Create an API token restricted to the intended account with the **Workers AI** permission needed to run/read inference (the Workers AI REST setup's token template). Do not use or share a global API key.
3. Set `ADMIN_CLOUDFLARE_ACCOUNT_ID` and `ADMIN_CLOUDFLARE_API_TOKEN` in the API service. Optionally select an available text model with `ADMIN_CLOUDFLARE_MODEL`.
4. Deploy and process a disposable digital PDF/TXT with **Cloudflare Workers AI** selected. The server calls only `https://api.cloudflare.com/client/v4/accounts/<id>/ai/run/<model>`; upstream redirects are refused and credentials are sent in a header, not the URL.

Cloudflare processes **extracted text**, not raw PDF bytes in this adapter. A scan/photo first needs admin Gemini or the optional OCR.space fallback. The UI explains this extra OCR step and shows the extraction method and writing provider. The existing **AI studio & prompts** provider test remains an explicit diagnostic of the *student* service; it is not the admin document provider and only makes calls when requested.

## Neon and version compatibility

The approval flow reuses the existing `uploaded_files`, `materials`, `material_versions`, `material_chunks`, `site_images`, `courses` and administrator-actor tables. **No new migration, database reset, student-profile flag, Firebase rule or role grant is introduced.** If existing document-library schema is missing, review/apply the existing migrations (including `003_site_and_documents.sql`) through the owner deployment guide. Do not enable `STUDENT_PROFILES_ENABLED` merely to display identity or use this admin desk.

Saving respects `FILE_STORAGE_LIMIT_MB`. A short transaction serializes upload-budget checks/approvals, inserts a TXT upload, writes the library/version/chunks and marks the upload saved. A failure rolls back all of these writes. A stable job UUID is the approval identity, so double clicks and retries of the same save do not create extra versions, even if the acknowledgement was lost. The UI freezes the exact approval on uncertain transport/5xx replies and offers **Retry the same save**; check **Classic upload → Recent uploads** before creating a different job if a restart lost its temporary state.

The TXT appears in Recent uploads with method **Reviewed in Counsel Working Station**. Its download is the approved text, **not the original PDF**. Original-file retention/download remains a Classic upload feature. Existing student visibility, Premium, Google-only access, installation checks and quota enforcement are unchanged.

## Temporary drafts and limits

- Draft jobs are **owner-scoped server memory**: not Neon, browser localStorage/sessionStorage/IndexedDB, or a service-worker cache. They have a one-hour access window after processing, are periodically pruned, and disappear on restart/redeploy/Render sleep. Download important results before leaving.
- Limits: one file up to **8 MB**, at most **80 PDF pages**, **180,000 source characters**, **6,000 instruction characters**, and **360,000 edited-result characters**. Split larger documents or use Classic upload where appropriate.
- One document job processes at a time, at most two active jobs per administrator, with a bounded global queue/draft reservation. This protects the small API instance; it is not a provider quota increase.
- Changing admin accounts or signing out clears the browser editor, attachment, chat, options and statuses immediately. Late status/save replies cannot repopulate another account. Cancelling/new work deletes only the temporary draft, never saved materials or earlier versions. A provider request already in flight may finish/bill even after cancellation; later processing sections are stopped.
- Names, source/output text, provider messages and instructions are rendered as text, never executable HTML. The model has no database tools or arbitrary URL fetch capability. Its output cannot authorize a save or publication.
- Missing pages, OCR errors or provider length limits are surfaced for review. AI correction is not a guarantee of a faithful legal transcription: compare citations, figures, page markers and every substantive passage with the source.

## Local verification and live boundary

Backend tests use stubbed provider HTTP responses and local PGlite SQL. Browser tests use synthetic accounts and stubbed API boundaries with external requests blocked. They exercise credential isolation, source validation, ownership, cancellation/expiry, incomplete-result approval, atomic saves/rollback/budget/idempotency, preserved versions, mobile layout, TXT downloads, follow-ups and account-change races. They do **not** validate live Cloudflare/Gemini credentials, real Neon permissions or a production deployment. Configure/review those privately and test disposable documents first.
