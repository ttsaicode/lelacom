# LelaConnect admin + ads update notes

This package is based on the latest uploaded `lela-video-chat-main.zip`.

Requested changes captured for the next implementation pass:
- Admin sessions should not persist after the admin page/tab is closed.
- Logging out should return to login and clear the username/password fields.
- Add a real Ads section to the admin dashboard.
- Ads should support image/video media, destination URL, scheduling, priority,
  enable/pause, frequency control, and basic impression/click tracking.
- Public ads should be dynamically loaded rather than hard-coded into index.html.
- Recommended placement: a compact sponsored card below the video area and above
  the main controls, without covering faces or chat.
- Arbitrary HTML/JavaScript ad code should not be accepted, to avoid XSS/security
  problems.

The current source files are otherwise preserved from the uploaded project.
