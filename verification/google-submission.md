# Google OAuth Verification: Submission Kit

Scopes requested: `gmail.send` (sensitive), plus `openid` and `email` (non-sensitive). Nothing in the Gmail read tier.
Replace every [PLACEHOLDER]. Google reviews against what the app actually does, so each statement below must be true in production.

## 0. Before you open the console
- [ ] Domain you own, verified in Google Search Console, added under "Authorized domains"
- [ ] Live, public (no login) pages: `https://app.yourdomain.com/welcome`, `/privacy`, `/terms` (all in `web/`)
- [ ] Privacy policy placeholders filled, and every claim in it true (token deletion on disconnect, [30]-day deletion, Limited Use paragraph)
- [ ] Homepage names the app exactly as on the consent screen, describes what it does, and links to the privacy policy
- [ ] Product logo (square, 120x120 PNG), support email, developer contact email
- [ ] A working reviewer account (see section 5)

## 1. Consent screen fields
| Field | Value |
|---|---|
| App name | [PRODUCT NAME] (must match the homepage and the video) |
| User support email | [SUPPORT EMAIL] |
| Home page | https://app.yourdomain.com/welcome |
| Privacy policy | https://app.yourdomain.com/privacy |
| Terms of service | https://app.yourdomain.com/terms |
| Authorized domain | yourdomain.com |
| Scopes | `.../auth/gmail.send`, `openid`, `.../auth/userinfo.email` |

Then: Publish App (Testing to Production), then "Prepare for Verification" and fill in the items below.

## 2. Scope justification (paste into the form)

**gmail.send**
> [PRODUCT NAME] is a CRM for small agencies and freelancers. Users write or review an email to one of their sales leads inside our app (we can suggest a draft with AI) and click "Approve & Send". We use the gmail.send scope solely to send that approved email from the user's own Gmail address, so it appears in the user's Sent folder and the recipient sees it from the user, not from us. Every email is sent only after an explicit user action; we never send automatically. We do not read, list, search, modify or delete any message in the user's mailbox. Replies from leads are collected through a Reply-To address on our own domain, not through the user's Gmail inbox.

**Why a narrower scope isn't sufficient**
> gmail.send is the narrowest Gmail scope that permits sending mail. We do not request gmail.readonly, gmail.modify, gmail.compose or any scope that grants read access. Alternatives such as sending from our own domain would remove the user's identity and sender reputation, which defeats the product's purpose (one-to-one outreach from the user's own address).

**openid / email**
> Used to identify which Google account the user connected, to display it in the app, and to set the From address. No other profile data is requested.

## 3. Data handling answers (use if asked)
- **What Google data is stored?** The user's Google email address and an OAuth refresh token (encrypted at rest with AES-256-GCM, key held outside the database). No mailbox content is accessed or stored from Google.
- **How is it used?** To send user-approved emails, and to show the connected address.
- **Shared with third parties?** No. Google user data is not shared, sold, or used for advertising or model training.
- **Deletion:** Disconnect in the app revokes the token with Google and deletes it. The account owner can use "Delete account" in the app, which revokes Gmail access and removes all workspace data immediately; backups are overwritten within [35] days.
- **Limited Use:** adopted verbatim in the privacy policy (section 3).

## 4. Demo video script (about 3 to 4 minutes; upload to YouTube as Unlisted)
Check Google's current demo-video requirements page before recording. Reviewers typically expect the points below.
Record in English (or add English captions), at 1080p, with a visible browser address bar the whole time.

| Time | Show | Say |
|---|---|---|
| 0:00 | Homepage `/welcome` | "This is [PRODUCT NAME], a CRM for small agencies. It lets users send follow-up emails to their leads from their own Gmail." |
| 0:20 | Sign in, open Business Profile, click **Connect Gmail** | "A user connects Gmail from their business profile." |
| 0:35 | The Google consent screen, **zoomed so the address bar with the OAuth client ID is readable**, then the app name and the requested permissions | "Google shows exactly what we request: send email on the user's behalf, and the user's email address. We do not ask to read mail." |
| 1:05 | Click Allow; return to the app showing "Connected as ...@gmail.com" | "The app now shows the connected account." |
| 1:20 | Add a lead; click **Generate Email with AI**; edit a sentence | "The user reviews and can edit the draft. Nothing sends automatically." |
| 2:00 | Click **Approve & Send**; open Gmail's Sent folder showing the message | "gmail.send is used here, and only here: to send this approved email from the user's own address." |
| 2:30 | Show the lead timeline logging the sent email | "We record the email in the lead's history in our own database." |
| 2:45 | Click **Disconnect**; show Google's permissions page no longer listing the app | "Users can disconnect at any time. This revokes the token and deletes it." |
| 3:10 | Show `/privacy`, scrolling to the Google user data and Limited Use section | "Our privacy policy documents this use and adopts Google's Limited Use requirements." |

## 5. Reviewer access
Give Google a working way in: a test Google account already added as a user, or a demo workspace login, plus a one-paragraph walkthrough of the steps in section 4. Make sure that account can complete the Connect Gmail step while the app is still in Testing.

## 6. Common reasons for rejection or delay
- Homepage or privacy policy behind a login, on an unverified domain, or not matching the app name
- Policy says one thing, product does another (for example claiming deletion that doesn't exist)
- Demo video skips the consent screen, hides the client ID, or doesn't show each scope being used
- Requesting more than you use (you only ask for send, so keep it that way)
- Unanswered emails from the review team: reply promptly, since replies pause the clock

## 7. After approval
Remove the 100-test-user cap in practice by publishing to production, keep the privacy policy in sync with any new feature, and re-verify before adding any scope. If you later add Gmail read access for two-way sync, that is the restricted tier and requires a third-party security assessment, so plan it as a separate project.
