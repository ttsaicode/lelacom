/* =========================================================================
   LELA — bilingual dictionary (English / አማርኛ)
   Applied by data-i18n keys in the HTML. No popups: the choice lives in the
   navbar and persists. Values use literal Unicode — no HTML entities —
   because they are written with textContent (or innerHTML when the value
   itself contains tags such as <b> or <a>).
   ========================================================================= */

(function () {
  "use strict";

  var EN = {
    /* Shared chrome */
    "a11y.skip": "Skip to content",
    "nav.how": "How it works",
    "nav.about": "About",
    "nav.contact": "Contact",
    "nav.enter": "Enter",
    "brand.word": "LELA",
    "nav.guidelines": "Guidelines",
    "nav.privacy": "Privacy",
    "nav.terms": "Terms",
    "live.initial": "Online",
    "live.count": "{n} online",
    "theme.toDark": "Switch to dark mode",
    "theme.toLight": "Switch to light mode",
    "drawer.open": "Open menu",
    "drawer.close": "Close menu",
    "drawer.menu": "Menu",
    "cta.start": "Start video chat",
    "cta.note": "Camera and microphone permission required. No sign-up.",
    "foot.desc": "Random one-on-one video chat. Peer-to-peer, moderated, no account.",
    "foot.legal": "© 2026 LELA. All rights reserved.",

    /* Landing */
    "idx.title": "LELA — Talk to a stranger",
    "idx.eyebrow": "Random video chat",
    "idx.h1a": "Talk to a",
    "idx.h1b": "<em>stranger.</em>",
    "idx.stand": "One person at a time, picked at random, live on camera. Peer-to-peer video, text chat alongside, and a report button that actually does something.",
    "idx.figAria": "Two video panels: a stranger waiting for a partner, and your camera — connected directly",
    "idx.nodeYou": "You",
    "idx.nodeYouSub": "Camera Off",
    "idx.direct": "Direct",
    "idx.nodeThem": "Stranger",
    "idx.nodeThemSub": "Waiting for partner…",

    "spec.video.k": "Video",
    "spec.video.v": "Peer to peer",
    "spec.accounts.k": "Accounts",
    "spec.accounts.v": "None",
    "spec.price.k": "Price",
    "spec.price.v": "Free",
    "spec.reports.k": "Reports",
    "spec.reports.v": "Read by a person",
    "spec.ages.k": "Ages",
    "spec.ages.v": "18 and over",

    "sec.how": "How it works",
    "sec.faq": "Questions",

    "step1.title": "Allow the camera",
    "step1.body": "The browser asks, you approve. Nothing is uploaded — the stream goes straight to whoever you get matched with.",
    "step2.title": "Get matched",
    "step2.body": "You are paired with someone else who is waiting. Usually a couple of seconds, never a queue of profiles to swipe through.",
    "step3.title": "Next, or report",
    "step3.body": "Hit <b>Next</b> for someone new. Hit <b>Report</b> if something is wrong — reports are reviewed and repeat offenders get banned.",

    "st.main": "Have a good time, and treat the person on the other side like you would at a cafe. Keep your real details to yourself, step away whenever you like — and if someone crosses a line, <b>the report button is right there.</b>",
    "st.meta": "Ages 18 and over. The",
    "st.link": "community guidelines",
    "st.metaEnd": "apply, and reports are read by a person.",

    "faq.q1": "Is it actually free?",
    "faq.a1": "Yes. There is no paid tier and nothing to upgrade. Ads cover the hosting and moderation costs.",
    "faq.q2": "Do I need an account?",
    "faq.a2": "No. Open the page, allow the camera, start. There is no email, no password and no profile to fill in.",
    "faq.q3": "Is anything recorded or stored?",
    "faq.a3": "Not by us. Video travels peer-to-peer and is never written to a server. If you press record it is captured on your own device, and you decide whether to keep it.",
    "faq.q4": "Who can see me?",
    "faq.a4": "One matched person at a time, for as long as one of you stays connected. Next severs the connection immediately.",
    "faq.q5": "What happens if someone misbehaves?",
    "faq.a5": "You report them, an admin reviews it, and repeated violations end in a ban. The report control is on screen during every session.",

    /* Contact page */
    "ct.title": "Contact — LELA",
    "ct.h1": "Let’s <em>talk.</em>",
    "ct.emailH": "Email",
    "ct.linksH": "Quick links",
    "ct.nameLabel": "Your name",
    "ct.stand": "A question about how LELA works, a problem on the site, or something you think the team should see — write it here.",
    "ct.copy": "Messages go straight to the team. Include the email you would like the reply sent to and as much detail as you can.",
    "ct.note": "Something happened inside a session? Use the report button in the chat instead. Those are read first and need no message.",
    "ct.topicLabel": "What is this about?",
    "ct.opt.general": "A general question",
    "ct.opt.broken": "Something is broken",
    "ct.opt.press": "Press or partnership",
    "ct.emailLabel": "Your email",
    "ct.msgLabel": "Message",
    "ct.send": "Send message",
    "ct.sending": "Sending",
    "ct.sentH": "Message sent.",
    "ct.sentP": "Thanks. It is with the team now — a reply comes to the address you used.",
    "ct.again": "Write another",
    "ct.err.email": "Enter an email address we can reply to.",
    "ct.err.message": "Write at least a sentence so we can help.",
    "ct.err.offline": "You appear to be offline. Check your connection and try again.",
    "ct.err.rate": "You have sent several messages recently. Give it a few minutes, then try again.",
    "ct.err.generic": "That did not go through. Try again in a moment.",

    /* About */
    "ab.title": "About — LELA",
    "ab.h1": "About <em>LELA</em>",
    "ab.stand": "A random video chat built the boring way: your camera goes to one person, not to us, and someone reads every report.",
    "ab.eyebrow": "ABOUT US",
    "ab.eye1": "WHAT WE STAND FOR",
    "ab.big1": "Small on purpose, <em>serious</em> where it counts.",
    "ab.eye2": "OUR MISSION",
    "ab.h2": "Keep the original <em>promise</em>.",
    "ab.eye3": "IN PRACTICE",
    "ab.s1": "Why it exists",
    "ab.p1": "Talking to a stranger used to be a normal thing on the internet. Most services that offered it either shut down, added walls of sign-up forms, or quietly started recording. LELA keeps the original promise — open the page, meet one person — and fixes the parts that made those services unpleasant: the accounts, the queues of profiles, and the absence of anyone in charge when something goes wrong.",
    "ab.p2": "It is deliberately small in scope. One stranger at a time, camera and text, a Next button and a Report button. Nothing to configure and nothing to swipe.",
    "ab.s2": "How moderation works",
    "ab.p3": "Every session carries a report control with reasons attached. A report does not vanish into a filter — it lands in an admin queue where a person opens it, checks the account history, and acts: a warning, a removal from the session, or a ban. Repeat offenders are banned. Blocks take effect immediately, without review, because in the moment you should not have to argue for them.",
    "ab.p4": "The full rules live in the <a href=\"/guidelines\">community guidelines</a>. They are short on purpose so they can actually be read.",
    "ab.s3": "What we never do",
    "ab.li1": "<b>No server-side recording.</b> Video and audio travel directly between the two browsers. The server introduces you and then steps out of the room.",
    "ab.li2": "<b>No accounts.</b> No email, no password, no profile, nothing to delete later because nothing was kept.",
    "ab.li3": "<b>No paywall.</b> There is no premium tier and no paid feature held back.",
    "ab.p5": "If you record an encounter yourself, that recording stays on your own device and is yours to keep or remove.",
    "ab.s5": "Say hello",
    "ab.p7": "Questions, bug reports, or press — the <a href=\"/contact\">contact page</a> reaches the team. For anything that happened inside a session, use the report button instead; those are read first.",
    "ab.fine": "Last reviewed September 2026. This page describes how LELA actually works today, not a roadmap.",

    /* Privacy */
    "pv.title": "Privacy — LELA",
    "pv.h1": "Privacy",
    "pv.stand": "The short version: your camera never reaches our servers, you have no account, and the things we do keep exist only to run and moderate the service.",
    "pv.s1": "What never touches our servers",
    "pv.p1": "<b>Video and audio.</b> They travel peer-to-peer, directly between the two browsers in a session, encrypted with DTLS-SRTP. There is no server-side recording of sessions, live or after the fact.",
    "pv.p2": "<b>Recordings you make.</b> If you use the record control, capture happens locally in your browser. You choose to save or delete it; we never receive it.",
    "pv.s2": "What is processed to make the service work",
    "pv.li1": "<b>Connection data.</b> Your IP address is handled transiently to deliver connections, count who is online, and rate-limit abuse. It is not turned into profiles.",
    "pv.li2": "<b>Text messages.</b> They are relayed through the server so they arrive in real time, in the same session as the video.",
    "pv.li3": "<b>Reports.</b> When you report someone, the report and its reason are stored so a moderator can review and act on it. This is the one case where content is kept, because moderation without it is theatre.",
    "pv.li4": "<b>Ad delivery.</b> We serve ads ourselves and record that an ad was shown or clicked, with a coarse timestamp, so advertisers can be billed accurately.",
    "pv.li5": "<b>Contact messages.</b> Anything you send through the contact page reaches the team and is kept until it has been dealt with.",
    "pv.s3": "Local storage",
    "pv.p3": "Small preferences may be kept in your own browser, on your own device. Clearing your browser data removes them. We do not use advertising cookies and we do not run third-party trackers on this site.",
    "pv.s4": "Your choices",
    "pv.p4": "There is no account to delete, because there are no accounts. To ask about data connected to an IP address or to send a privacy question, use the <a href=\"/contact\">contact page</a>. The service is for ages <b>18 and over</b>.",
    "pv.s5": "Changes",
    "pv.p5": "If what we collect changes materially, this page changes with it. The date below is when it was last reviewed.",
    "pv.fine": "Last reviewed September 2026. Draft for legal review before production reliance.",

    /* Terms */
    "tm.title": "Terms — LELA",
    "tm.h1": "Terms",
    "tm.stand": "Plain terms for using LELA. By starting a session you accept them.",
    "tm.s1": "Who can use LELA",
    "tm.p1": "You must be <b>18 years or older</b> to use the service. If you are not, close the page. There is no age verification at sign-up because there is no sign-up; the responsibility is yours.",
    "tm.s2": "How you must behave",
    "tm.p2": "Follow the <a href=\"/guidelines\">community guidelines</a>. They cover the short list of things that get you removed: nudity and sexual content, harassment, hate, anyone under 18, and recording other people without their consent. The guidelines form part of these terms.",
    "tm.s3": "Moderation and bans",
    "tm.p3": "Reports are reviewed by people. Depending on what happened, action ranges from a warning or a removal from the session to a temporary or permanent ban. Conduct that is illegal, or that endangers a minor, means an immediate permanent ban and, where required, a report to the relevant authorities. Moderation decisions on repeat violations are final; a one time appeal can be sent through the <a href=\"/contact\">contact page</a>.",
    "tm.s4": "Your content",
    "tm.p4": "What you say and show belongs to you. You grant LELA only the permission needed to deliver it to the other person in your session and to act on reports that concern it. We do not claim ownership of your sessions and we do not record them.",
    "tm.s5": "The service, as it is",
    "tm.p5": "LELA is provided as is and as available. Random video chat depends on browsers, networks and other people, so it can be interrupted, mismatched or offline; we do not warrant that it will always work or that any particular person will be available to talk. To the extent the law allows, we are not liable for indirect or consequential losses arising from use of the service.",
    "tm.s6": "Advertising",
    "tm.p6": "The service is free and funded by advertising. Ads are served by LELA and may change without notice. Ads are not endorsements, and interactions with advertisers are between you and them.",
    "tm.s7": "Changes",
    "tm.p7": "These terms may be updated. Continued use after a change means you accept the updated terms. The date below is when this page was last reviewed.",
    "tm.fine": "Last reviewed September 2026. Draft for legal review before production reliance.",

    /* Guidelines */
    "gl.title": "Community guidelines — LELA",
    "gl.h1": "Community guidelines",
    "gl.stand": "Short on purpose, so they can actually be read before you press start.",
    "gl.s1": "The rules",
    "gl.li1": "<b>18 and over.</b> The service is for adults. If you are under 18, close the page.",
    "gl.li2": "<b>No nudity or sexual content.</b> This is not that kind of service. It never was.",
    "gl.li3": "<b>No minors, ever.</b> Anyone under 18 must not be on camera here, and no sexual content involving a minor is tolerated under any circumstance. Report sightings immediately.",
    "gl.li4": "<b>No harassment or hate.</b> Slurs, threats, targeted abuse and bigotry toward anyone's race, gender, sexuality, religion or disability end your access.",
    "gl.li5": "<b>Do not record people without consent.</b> The record control captures your own device. Screen recordings and shares of other people require their agreement.",
    "gl.li6": "<b>No spam.</b> Advertising, soliciting, or dumping links at strangers gets you removed.",
    "gl.li7": "<b>No illegal content or activity.</b> Anything criminal on camera means an immediate ban and a report to authorities where the law requires it.",
    "gl.li8": "<b>Next is always allowed.</b> You never owe anyone a conversation. Leaving needs no explanation.",
    "gl.s2": "How reporting works",
    "gl.p1": "The report control sits on screen during every session. Pick a reason, send it, and a person reviews it against the account history. Blocks are immediate without review — you should not have to argue to stop seeing someone.",
    "gl.s3": "What happens when a rule breaks",
    "gl.p2": "First: a warning or removal from the session. Repeat: a temporary ban. Continued or severe behavior: a permanent ban. Illegal content or anything involving a minor skips every step. Enforcement decisions on repeat violations are final; one-time appeals go through the <a href=\"/contact\">contact page</a>.",
    "gl.fine": "Last reviewed September 2026.",

    /* 404 */
    "nf.title": "Page not found — LELA",
    "nf.h1": "This page does not <em>exist.</em>",
    "nf.stand": "The link may be old or typed wrong. Everything else is one step away.",
    "nf.back": "Back to LELA"
  };

  var AM = {
    /* Shared chrome */
    "a11y.skip": "ወደ ይዘቱ ዝለል",
    "nav.how": "እንዴት እንደሚሰራ",
    "nav.about": "ስለ እኛ",
    "nav.contact": "አግኙን",
    "nav.enter": "ይግቡ",
    "brand.word": "ሌላ",
    "nav.guidelines": "መመሪያዎች",
    "nav.privacy": "ግላዊነት",
    "nav.terms": "ውሎች",
    "live.initial": "በመስመር ላይ",
    "live.count": "{n} በመስመር ላይ",
    "theme.toDark": "ወደ ጨለማ ሁነታ ቀይር",
    "theme.toLight": "ወደ ብርሃን ሁነታ ቀይር",
    "drawer.open": "ምናሌ ክፈት",
    "drawer.close": "ምናሌ ዝጋ",
    "drawer.menu": "ምናሌ",
    "cta.start": "የቪዲዮ ውይይት ይጀሙ",
    "cta.note": "የካሜራና የማይክሮፎን ፈቃድ ያስፈልጋል። መመዝገብ አያስፈልግም።",
    "foot.desc": "በአንድ ወደ አንድ የቪዲዮ ውይይት። በቀጥታ ጋር ጋር፣ ተቆጣጣሪ፣ መለያ የለም።",
    "foot.legal": "© 2026 LELA. ሁሉም መብቶች የተጠበቁናቸው።",

    /* Landing */
    "idx.title": "LELA — ማያውቃቸውን ሰው ይገናኙ",
    "idx.eyebrow": "የራንደም የቪዲዮ ውይይት",
    "idx.h1a": "ማያውቃቸውን",
    "idx.h1b": "<em>ሰው ይገናኙ።</em>",
    "idx.stand": "በአንድ ጊዜ አንድ ሰው — በራንደም የሚመረጥልዋል፣ በካሜራ በቀጥታ። ቀጥታ የሚሄድ ቪዲዮ፣ አጠገבו የሚሄድ የቃል መልዕክት፣ እና ተግባራዊ የሪፖርት አዝማሚያ።",
    "idx.figAria": "ሁለት የቪዲዮ ሰነዶች: ጋር የሚጠብቅ ማያልወቅ፣ እና የእርስዎ ካሜራ — በቀጥታ ተገናኝተዋል።",
    "idx.nodeYou": "እርስዎ",
    "idx.nodeYouSub": "ካሜራ ጠፍቷል",
    "idx.direct": "ቀጥታ",
    "idx.nodeThem": "ማያልወቅ",
    "idx.nodeThemSub": "የጋር ይጠብቃል…",

    "spec.video.k": "ቪዲዮ",
    "spec.video.v": "ቀጥታ (P2P)",
    "spec.accounts.k": "መለያ",
    "spec.accounts.v": "የለም",
    "spec.price.k": "ዋጋ",
    "spec.price.v": "ነጻ",
    "spec.reports.k": "ሪፖርቶች",
    "spec.reports.v": "በሰው ይነበባል",
    "spec.ages.k": "ዕድመ",
    "spec.ages.v": "ከ18 እና በላይ",

    "sec.how": "እንዴት እንደሚሰራ",
    "sec.faq": "ጥያቄዎች",

    "step1.title": "ካሜራውን ይፈቀዱ",
    "step1.body": "በራስሰር ጥያቄ ይመጣል፤ እርስዎ ያጽዒኑታል። ምንም አይስቀልም — ወደ ተገናኘው ሰው ቀጥታ ይሄዳል።",
    "step2.title": "ከአንድ ሰው ጋር ይገናኙ",
    "step2.body": "በአሁን የሚጠብቁትን አንድ ሰው ጋር ይገናኛሉ። ብዙ ጊዜ ገደማ ገናታ ይወስዳል — የመደረብ ዝርዝር የለም።",
    "step3.title": "ቀጥል ወይም አሳውቅ",
    "step3.body": "አዲስ ሰው ለማግኘት <b>ቀጥል</b> ያንቁ። ችግር ካለ — <b>አሳውቅ</b>፤ ሪፖርቶች ይመረምራሉ፣ ተደጋጋሚ የሚጠፉ ሰዎች ይታገላሉ።",

    "st.main": "ተደሰቱ፤ ከኩንታል ላይ ያለውን ሰው በካፌ ከሰዎች ጋር እንደሚመስል አድርጉት። የእርስዎ የግል መረጃዎች የእርስዎ ናቸው፣ ቀጥል በአንድ ጠቅታ አለው — እና መስፈርት ሰጥቶ ካልቀረ <b>የሪፖርት አዝማሚያው እዚያ አለ።</b>",
    "st.meta": "ከ18 ዓመት በላይ።",
    "st.link": "የማህበረሰብ መመሪያዎች",
    "st.metaEnd": "ተፈጻሚ ናቸው፤ ሪፖርቶችም በሰው ይነበባሉ።",

    "faq.q1": "በትክክል ነጻ ነው?",
    "faq.a1": "አዎ። የሚከፈል ደረጃ የለምም ማስፋፋት የለም። ማስተዋወያ የአሰሪና የቆጣጠሪ ወጪዎችን ይሸፍላል።",
    "faq.q2": "መለያ ያስፈልጋል?",
    "faq.a2": "አይ። ገጹን ይክፈቱ፣ ካሜራውን ይፈቀዱ፣ ይጀሙ። ኢሜይል፣ የይለፍ ቃልና ማስገባት የሚገባ መገለጫ የለም።",
    "faq.q3": "ምንም ይቀረጻል ወይም ይቀመጣል?",
    "faq.a3": "በእኛ አይ። ቪዲዮ በቀጥታ ከመሣሪያ ወደ መሣሪያ ይሄዳል፤ ወደ ሰርቨር አይነበብም። መቅረጽ ተጫንተው በእርስዎ መሣሪያ ላይ ይይዛል፣ መቀመጥ ወይም ማጥፋት እርስዎ ይወስናሉ።",
    "faq.q4": "ማን ማያችሁን?",
    "faq.a4": "በአንድ ጊዜ አንድ ተገናኛች ሰው፣ አንዳቸው ተገናኝተው ያለከኔው ድረስ። ቀጥል ግንኙነቱን ወዲያውኑ ያቋርጣል።",
    "faq.q5": "ሰው ቢጠፋበት ምን ይከሰታል?",
    "faq.a5": "ሪፖርት ያደርጋሉ፣ አስተዳዳሪ ይመረምራል፣ ተደጋጋሚ መጣስ ወደ መትጠፍ ይመራል። የሪፖርት ቁጥጥር በእያንዳንዱ ክፍለ ጊዜ በጻጥ ላይ አለ።",

    /* Contact page */
    "ct.title": "አግኙን — LELA",
    "ct.h1": "<em>እንነጋገር።</em>",
    "ct.emailH": "ኢሜይል",
    "ct.linksH": "ፈጣን አገናኙዎች",
    "ct.nameLabel": "የስምዎ",
    "ct.stand": "ስለ LELA እንዴት እንደሚሰራ ጥያቄ፣ በድረ-ገጹ ላይ ችግር፣ ወይም ቡድኑ ማያውቀው ያለበትን ነገር — እዚህ ይጻፉ።",
    "ct.copy": "መልዕክቶች ወደ ቡድኑ በቀጥታ ይሄዳሉ። መልስ የሚደርስባችሁ ኢሜይልና የሚቻል ዝርዝር ያካትቱ።",
    "ct.note": "በክፍል ውስጥ የሆነ ነገር ተፈጥሯል? የሪፖርት ቁልፉን በውይይቱ ውስጥ ይጠቀሙ። እነሱ ቀድመው ይነበባሉ፣ መልዕክት አያስፈልግም።",
    "ct.topicLabel": "ስለ ምንድን ነው?",
    "ct.opt.general": "አጠቃላይ ጥያቄ",
    "ct.opt.broken": "ችግር አለ",
    "ct.opt.press": "ሚዲያ ወይም አጋር ሥራ",
    "ct.emailLabel": "የእርስዎ ኢሜይል",
    "ct.msgLabel": "መልዕክት",
    "ct.send": "መልዕክት ይላኩ",
    "ct.sending": "በመላክ ላይ",
    "ct.sentH": "መልዕክት ተልኳል።",
    "ct.sentP": "እናመሰግናለን። አሁን ወደ ቡድኑ ደርሷል — መልስ የሚጠቀሙበት ኢሜይል ይመጣል።",
    "ct.again": "ሌላ ይጻፉ",
    "ct.err.email": "መልስ የሚደርስብን ኢሜይል ያስገቡ።",
    "ct.err.message": "እንድናገዝልዎት ከአንድ ሐረግ በላይ ይጻፉ።",
    "ct.err.offline": "ከመስመርው ያሉ ቺንት። ግንኙነትዎን ያረጋግጡ እንደገና ይሞክሩ።",
    "ct.err.rate": "በአንድ ጊዜ በርካሽ መልዕክት ልኳልኩ። ጠቂት ደቂቃዎች ይጠብቁ እንደገና ይሞክሩ።",
    "ct.err.generic": "ልኳል አልተሳካም። ትንሽ ቆይተው እንደገና ይሞክሩ።",

    /* About */
    "ab.title": "ስለ እኛ — LELA",
    "ab.h1": "ስለ <em>LELA</em>",
    "ab.stand": "በመደበኛ የሠራ በይነፈን የቪዲዮ ውይይት፦ የእርስዎ ካሜራ ወደ አንድ ሰው ይሄዳል — ወደ እኛ አይደለም፤ ሁሉንም ሪፖርት ሰው ያነባል።",
    "ab.eyebrow": "ስለ እኛ",
    "ab.eye1": "የምንደግፈው",
    "ab.big1": "በግድ ትንሽ፤ አስፈላጊበት ቦታ <em>ጉራሚ</em>።",
    "ab.eye2": "ተልዕኮአችን",
    "ab.h2": "የመጀመሪያውን <em>ቃልኪዳን</em> መጠበቅ።",
    "ab.eye3": "በተግባር",
    "ab.s1": "ለምን እንዳለ",
    "ab.p1": "ከማያውቃቸው ሰው ጋር መነጋገር በኢንተርኔት ውስጥ መደበኛ ነገር ነበር። የሚያቀርቡት አብዛኞች አገልግሎቶች ወይ ተዘግተዋል፣ ወይም የመመዝገቢያ ቅጽ ግድ አድርገዋል፣ ወይም በስትቶ መቅረጽ ጀምረዋል። LELA የመጀመሪያውን ቃል ያስጠብቃል — ገጹን ክፈት፣ አንድ ሰው ጋር ጋናኝ — እነዚያን አገልግሎቶች አላስብቀት የሠሩትንም ክፍሎች ያስተካክላል፦ መለያዎች፣ የመገለጫ ማቀሚያዎች፣ እና ምንም ችግር ሲፈጠር ምንም ሰው ሳይመራ።",
    "ab.p2": "ዓይኑ በግምት ትንሽ ነው። በአንድ ጊዜ አንድ ሰው፣ ካሜራና ቃል፣ የቀጥልና የሪፖርት ቁልፍ። ምንም ማስተካከል የለምም ማንሳት የለም።",
    "ab.s2": "እንዴት እንደሚቆጣጠር",
    "ab.p3": "በእያንዳንዱ ክፍለ ጊዜ ምክንያት ያለው የሪፖርት ቁጥጥር አለ። ሪፖርቱ በማጣሪያ አይጠፋም — ወደ አስተዳዳሪ ማስረከቢያ ይደረጋል፣ እዚያ ሰው ከከፈተው፣ የመለያ ታሪክን ሞክሮ ያስፈርጉታል፦ ማስታወቂያ፣ ከክፍሉ መድፍ ወይም መትጠፍ። ተደጋጋሚ የሚጠፉ ሰዎች ይታገላሉ። መገልፎች ወዲያውኑ — ምንም ማጣራት አያስፈልግም — በወቅቱ ለመካከሻ አለመደረግ እንደሚገባን ስለሆነ።",
    "ab.p4": "ሙሉ መመሪያዎች በ<a href=\"/guidelines\">የማህበረሰብ መመሪያዎች</a> ውስጥ ናቸው። በተለይ ወጡ እንዲነበቡ ስለሆነ።",
    "ab.s3": "ምንም አንደፈጽም",
    "ab.li1": "<b>በሰርቨር መቅረጽ የለም።</b> ቪዲዮና ድምጺ በቀጥታ በሁለቱ መሣሪያዎች መካከል ይሄዳል። ሰርቨሩ ያገናኝልዎትን ከፈለግ ብቻ ከክፍሉ ይወጣል።",
    "ab.li2": "<b>መለያ የለም።</b> ኢሜይል የለም፣ የይለፍ ቃል የለም፣ መገለጫ የለም፣ ምንም አልቀመጥም ስለሆነ የማጥፋት ነገር የለም።",
    "ab.li3": "<b>ክፍያ ችግር የለም።</b> የተከፈለበት ደረጃ የለምም የተከፈለ ባህሪ የተጠበቀ።",
    "ab.p5": "ብቻዎን ከቀረጹ፣ ቀረጻው በእርስዎ መሣሪያ ላይ ይቀላል፣ መጥቀም ወይም ማጥፋት የእርስዎ ነው።",
    "ab.s5": "ሰላም ይሉን",
    "ab.p7": "ጥያቄዎች፣ የተቃጠለ ሪፖርት ወይም ሚዲያ — <a href=\"/contact\">የአግናኝ ገጽ</a> ወደ ቡድኑ ይደርሳል። በክፍል ውስጥ የሆነ ነገር ለሆነ የሪፖርት ቁልፉን ይጠቀሙ፤ እነሱ ቀድመው ይነበባሉ።",
    "ab.fine": "ሴፕቴምበር 2026 ተመርምሯል። ይህ ገጽ ዛሬ LELA በትክክል እንዴት እንደሚሰራ ይገልጻል — መስራች እቅድ አይደለም።",

    /* Privacy */
    "pv.title": "ግላዊነት — LELA",
    "pv.h1": "ግላዊነት",
    "pv.stand": "አጭሩ ይህ ነው፦ የእርስዎ ካሜራ ወደ ሰርቨርች እንኳ አይደርስም፣ መለያ የለዎትም፣ የምንቀምጣቸው ነገሮች አገልግሎቱን ለመስራትና ለመቆጣጠር ብቻ ናቸው።",
    "pv.s1": "ወደ ሰርቨርች እንኳ አይደርሱ ያሉት",
    "pv.p1": "<b>ቪዲዮና ድምጺ።</b> በቀጥታ በሁለቱ መሣሪያዎች መካከል በDTLS-SRTP ተመስሯ ይሄዳል። ሕይወት ወይም ከዚያ በኋላ በሰርቨር ላይ መቅረጽ የለም።",
    "pv.p2": "<b>እርስዎ የሚቀርጻቸው።</b> የቅረጽ መቆጣጠሪያ ከተጫኑ ቀረጻ በእርስዎ መሣሪያ ውስጥ ይደረጋል። መቀመጥ ወይም ማጥፋት እርስዎ ይወስናሉ፤ እኛ አንቀበለውም።",
    "pv.s2": "አገልግሎቱ እንዲሰራ የሚከተለው መረጃ",
    "pv.li1": "<b>የግንኙነት መረጃ።</b> አይፒ አድራሻዎ ግንኙነት ለመላክ፣ ማን እንዳለ ለመፈለግ እና ጥፋት ለመከላከል በአጭር ጊዜ ይተናል። ወደ መገለጫ አይቀየርም።",
    "pv.li2": "<b>የቃል መልዕክቶች።</b> በሰርቨር በኩል በቀጥታ ጊዜ እንዲደርሱ ይተላለፋሉ፣ ቪዲዮውን ጋር በአንድ ክፍለ ጊዜ።",
    "pv.li3": "<b>ሪፖርቶች።</b> ማንኛውንም ሲያሳውቁ ሪፖርቱና ምክንያቱ ይቀመጣል — ማያያዣው ለመመርመርና ለመስራት እንዲችል። ይህ ይዘት የሚቀመጥበት አንድ የተለየ ጊዜ ነው፣ ከቆጣጠር ውጭ ማለት ማመስገን ብቻ ስለሆነ።",
    "pv.li4": "<b>ማስተዋወያ ማቅረብ።</b> ማስተዋወያ በእኛ ብቻ እናቅርባለን፤ አንድ ማስተዋወያ እንዴት እንደተመለከተና ተጫንቻው ከጊዜ ጋር ይመዘገባል — ለአስተዋወያዎች በትክክል እንዲከፈል።",
    "pv.li5": "<b>የአግናኝ መልዕክቶች።</b> በአግናኝ ገጽ የሚላኩ ሁሉ ወደ ቡድኑ ይደርሳል፤ እስኪፈታ።",
    "pv.s3": "በአካባቢ ማከማቻ",
    "pv.p3": "ትንሽ ምርጫዎች በእርስዎ መሣሪያ ላይ ሊቀመጡ ይችላሉ። የመሣሪያውን መረጃ አጽዳት አያስወግዱታቸውም። የማስተዋወያ ኩኪዎችን አንጠቀምም ሦስተኛ ወገን ተላላፊ አንቀልም።",
    "pv.s4": "የእርስዎ ምርጫዎች",
    "pv.p4": "ለማጥፋት የሚደረግ መለያ የለም — ምክንያቱም መለያ የለም። አይፒ ጋር ተመስሮ ማንኛውም መረጃ ለማጠየቅ ወይም የግላዊነት ጥያቄ ለማስገባት <a href=\"/contact\">የአግናኝ ገጩን</a> ይጠቀሙ። አገልግሎቱ ለ<b>ከ18 ዓመት በላይ</b> ነው።",
    "pv.s5": "ልዎች",
    "pv.p5": "ምንም ከምንሰበሰብ በአስራት ከተለየ ከተቀየረ ገጹም ይቀየራል። ከዚህን በታች ያለው ቀን የመጨረሻ ጥበቃ ቀን ነው።",
    "pv.fine": "ሴፕቴምበር 2026 ተመርምሯል። ከምርጫ ጥቀም በፊት በሕግ ባለሙያ የሚታይ ፈተና።",

    /* Terms */
    "tm.title": "ውሎች — LELA",
    "tm.h1": "ውሎች",
    "tm.stand": "LELAን ለመጠቀም ቀላል ውሎች። ክፍለ ጊዜ ለመጀመር ተቀባይ ነዎት።",
    "tm.s1": "ማን መጠቀም ይችላል",
    "tm.p1": "አገልግሎቱን <b>18 ዓመት እና በላይ</b> መሆን አለብዎት። ካልሆኑ ገጹን ዝጋ። በመመዝገቢያ ላይ ዕድመ ማረጋገጫ የለም — ምክንያቱም መመዝገቢያ የለም፤ ኃላፊነት የእርስዎ ነው።",
    "tm.s2": "እንዴት መሆን አለብዎት",
    "tm.p2": "<a href=\"/guidelines\">የማህበረሰብ መመሪያዎችን</a> ይከተሉ። ከመፈረሚያ የሚቀሩትን አጭር ዝርዝር ይሸፍላሉ፦ እርግጥና የአልቦነትና የጾታዊ ይዘት፣ ግፊት፣ ጸርፊት፣ ከ18 በታች ማንኛውም ሰው፣ እና ሌሎችን በፈቃዳቸው ያልቀረጹ። መመሪያዎቹ ከዚህ ውሎች አንዱ ናቸው።",
    "tm.s3": "ቆጣጠርና መትጠፍ",
    "tm.p3": "ሪፖርቶች በሰው ይመረምራሉ። የተፈጠረውን በመመስል እርምጃ ከማስታወቂያ ወይም ከክፍሉ መድፍ እስከ ጊዜያዊና ዘላቂ መትጠፍ ይለያያል። ሕጩ የተቃጠለ ወይም ትንሽ አድናቆተኛ የሚጎዳ ጥፋት ወዲያውኑ ዘላቂ መትጠፍ ነው — ሕጩ ከሚፈልገው ኃሳፎች ሪፖርት። በተደጋጋሚ መጣስ የሚደረጉ ተፈሪዎች የመጨረሻ ናቸው፤ አንድ ጊዜ ወክለኛ <a href=\"/contact\">የአግናኝ ገጩን</a> ይጠቀሙ።",
    "tm.s4": "የእርስዎ ይዘት",
    "tm.p4": "ያሉትና የሚያዩት የእርስዎ ነው። LELA የሚፈልገውን ፈቃድ ብቻ ይሰጣል — በክፍል ውስጥ ለሁለተኛው ለመላክና ለሚመለከተው ሪፖርት ለመስራት። ከክፍሎች ባለቤነት አንልምም አንቀረጻቸውም።",
    "tm.s5": "አገልግሎቱ፣ በሆነበት ሁኔታ",
    "tm.p5": "LELA በሚገኝበት ሁኔታና በሚገኝበት ጊዜ ነው። በይነፈን የቪዲዮ ውይይት ከመሣሪያዎች፣ ከመስመሮችና ከሰዎች ጋር አምቶ ስለሆነ ተቋርጠው ወይም ያለ ተገናኛ ሊሆን ይችላል፤ ዘወትር እንደሚሰራ ወይም ተወዳጅ ሰው እንደሚገኝ አንስምም። ሕጩ የሚፈቅደው ድርሰት መጠን ብርሃንና ቀጣይ ኪሳራት ከአገልግሎቱ እንቅስቃሴ ስለሚፈጠር አንልም።",
    "tm.s6": "ማስተዋወያ",
    "tm.p6": "አገልግሎቱ ነጻ ነውና በማስተዋወያ ይመገባል። ማስተዋወያዎች በLELA ይታቀባሉ፤ ሳያውቁ ሊቀየሩ ይችላሉ። ማስተዋወያ የተረጋገጠ አይደለም፤ ከአስተዋወያዎች ጋር የሚደረጉ ግንኙነቶች ከእርስዎ ጋር ናቸው።",
    "tm.s7": "ልዎች",
    "tm.p7": "ይህች ውሎች መተካት ይችላሉ። ከተቀየረ በኋላ መጠቀም ቀጥታ ተቀባይነት ማሳየት ነው። በታች ያለው ቀን የመጨረሻ ጥበቃ ቀን ነው።",
    "tm.fine": "ሴፕቴምበር 2026 ተመርምሯል። ከምርጫ ጥቀም በፊት በሕግ ባለሙያ የሚታይ ፈተና።",

    /* Guidelines */
    "gl.title": "የማህበረሰብ መመሪያዎች — LELA",
    "gl.h1": "የማህበረሰብ መመሪያዎች",
    "gl.stand": "በተለይ ወጡ — ከመጀመርዎ በፊት እንዲነበቡ።",
    "gl.s1": "መመሪያዎች",
    "gl.li1": "<b>18 እና በላይ።</b> አገልግሎቱ ለአዉราะዎች ነው። ከ18 በታች ከሆኑ ገጹን ዝጋ።",
    "gl.li2": "<b>እርግጥና የአልቦነት ወይም የጾታዊ ይዘት የለም።</b> ይህ ይህ ዓይነት አገልግሎት አይደለም። አልነበረም።",
    "gl.li3": "<b>ትንሹ አይደለም፣ እስካሁንም።</b> ማንኛውም ከ18 በታች እዚህ በካሜራ መገኘት አይገባም፤ ትንሽ አድናቆተኛ የሚጎዳ የጾታዊ ይዘት በማንኛውም ሁኔታ አይቀበልም። ቅጽበት ወዲያውኑ ያሳውቁ።",
    "gl.li4": "<b>ግፊትና ጸርፊት የለም።</b> ግርማ፣ ይግራና በማንኛውም ማንነት፣ ሴቱነት፣ እምነት ወይም ተናጥብነት ላይ የተመሰረተ ግፊት የመድረክዎን መጠቀም ያስቁራል።",
    "gl.li5": "<b>በፈቃዳቸው ሰዎችን አያቀርቡ።</b> የቅረጽ ቁጥጥር የእርስዎን መሣሪያ ይይዛል። የማያ ትንተኛ ቀረጻና ሌሎችን ማካፈል ፈቃዳቸው ይጠይቃል።",
    "gl.li6": "<b>ሳም የለም።</b> ማስተዋወያ፣ ማውራት ወይም ለማንኛውም ሰው አገናኝ ማንሳት ይፈራረማል።",
    "gl.li7": "<b>ሕጩ የተቃጠለ ይዘት ወይም እቅፍ የለም።</b> በካሜራ ላይ ማንኛውም የወሰደው ወዲያውኑ መትጠፍ ነው፤ ሕጩ ከሚፈልገው ኃሳፎች ሪፖርት።",
    "gl.li8": "<b>ቀጥል ዘወትር ተፈቃሪ ነው።</b> ለማንኛውም ውይይት ግዴታ የለብዎትም። መውጣት ምክንያት አያስፈልግም።",
    "gl.s2": "እንዴት ሪፖርት ይሰራል",
    "gl.p1": "የሪፖርት ቁጥጥሩ በእያንዳንዱ ክፍለ ጊዜ በጻጥ ላይ አለ። ምክንያት ይምረጡ፣ ይላኩ፣ ሰው ከመለያ ታሪክ ጋር ይመረምረዋል። መገልፎች ወዲያውኑ — ምንም ማጣራት አያስፈልግም — ሰውን ለማየት ከመዋደል አለመድረግ እንዳለብን ስለሆነ።",
    "gl.s3": "መመሪያ ሲጠፋ ምን ይከሰታል",
    "gl.p2": "መጀመሪያ፦ ማስታወቂያ ወይም ከክፍሉ መድፍ። ተደጋጋሚ፦ ጊዜያዊ መትጠፍ። ቀጥሎ ወይም ከባድ፦ ዘላቂ መትጠፍ። ሕጩ የተቃጠለ ወይም ትንሽ አድናቆተኛ የሚጎዳ ውህስ ዝርዝሩን ይለያል። በተደጋጋሚ መጣስ የሚደረጉ ተፈሪዎች የመጨረሻ ናቸው፤ አንድ ጊዜ ወክለኛ <a href=\"/contact\">የአግናኝ ገጩን</a> ይጠቀሙ።",
    "gl.fine": "ሴፕቴምበር 2026 ተመርምሯል።",

    /* 404 */
    "nf.title": "ገጽ አልተገኘም — LELA",
    "nf.h1": "ይህ ገጽ <em>አይገኝም።</em>",
    "nf.stand": "አገናኙ አሮጌ ወይም ትንተኛ ተጻፎ ካልሆነ። ሌሎቹ አንድ ደረጃ የሆኑ ናቸው።",
    "nf.back": "ወደ LELA ተመለስ"
  };

  var DICT = { en: EN, am: AM };

  function currentLang() {
    return document.documentElement.getAttribute("lang") === "am" ? "am" : "en";
  }

  function applyLang(lang) {
    if (lang !== "am" && lang !== "en") lang = "en";

    var dict = DICT[lang];
    var root = document.documentElement;

    root.setAttribute("lang", lang);
    root.setAttribute("data-lang", lang);

    var nodes = document.querySelectorAll("[data-i18n]");

    for (var i = 0; i < nodes.length; i += 1) {
      var el = nodes[i];
      var value = dict[el.getAttribute("data-i18n")];

      if (value == null) continue;

      if (value.indexOf("<") !== -1) {
        el.innerHTML = value;
      } else {
        el.textContent = value;
      }
    }

    /* Attributes such as aria-label: key pairs, separated by ";". */
    var attrNodes = document.querySelectorAll("[data-i18n-attr]");

    for (var j = 0; j < attrNodes.length; j += 1) {
      var pairs = attrNodes[j].getAttribute("data-i18n-attr").split(";");

      for (var k = 0; k < pairs.length; k += 1) {
        var parts = pairs[k].split(":");
        if (parts.length !== 2) continue;

        var attrValue = dict[parts[1].trim()];
        if (attrValue != null) {
          attrNodes[j].setAttribute(parts[0].trim(), attrValue);
        }
      }
    }

    var titleEl = document.querySelector("title[data-i18n-title]");
    if (titleEl) {
      var titleValue = dict[titleEl.getAttribute("data-i18n-title")];
      if (titleValue != null) document.title = titleValue;
    }

    var langButtons = document.querySelectorAll("[data-lang]");

    for (var m = 0; m < langButtons.length; m += 1) {
      var on = langButtons[m].getAttribute("data-lang") === lang;
      langButtons[m].setAttribute("aria-pressed", on ? "true" : "false");
    }
  }

  window.LELA_I18N = DICT;
  window.lelaApplyLang = applyLang;
  window.lelaCurrentLang = currentLang;

  /* The dictionary applies itself the moment it exists: the tab title and
     every data-i18n node follow the stored language with no other trigger. */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      applyLang(currentLang());
    });
  } else {
    applyLang(currentLang());
  }
})();
