// The DreamFace web map behind `dreamface/sitemap`: what an agent driving the pages needs before it clicks.
//
// Written from a depth-first walk of the test environment with the typed browser tools (tab_observe / tab_act /
// tab_read / tab_expect), so every entry is something that was seen, not read from the front-end source. Visible
// texts are quoted as they appear so they can be used as text/role+name targets; refs (eN) are never recorded because
// they expire on every re-render. Update this file (and VERIFIED) when a walk finds a change — see README.md here.

/** When and how the map was last checked. */
export const VERIFIED = '2026-09-29 on https://testm.facemojiapp.com, logged in as a Free account (967 credits, 5 free uses a day), English UI';

/** The two front ends that share the origin. They look different, load different bundles and 404 into the SEO shell. */
export const LAYERS = [
  {
    layer: 'studio',
    what: 'The logged-in creation app (bundle static.dreamfaceapp.com/dreamfaceweb/dreamface-web). Left sidebar of plain text items (not links): Home, Canvas, Agent, Avatar, Video, Image, All Tools, Creations, Get App, Contact Us, API; top right the paid credit count (e.g. "967") and a "Free" plan button, then an unnamed avatar button.',
    start: '/home',
  },
  {
    layer: 'seo',
    what: 'The Nuxt marketing site (bundle cdnseo.dreamfaceapp.com). Header "AI Tools" / "Template" / "Gallery" / "Blog", a language trigger ("En" / "简") and "Start Now". English paths have no prefix; Chinese adds /zh. Unknown paths, including studio-looking ones such as /agent or /creations, render this shell\'s 404.',
    start: '/',
  },
];

/**
 * Routes, parent first. `via` is how to reach the route from its parent (prefer opening the URL directly: sidebar
 * and card clicks are unreliable, see traps). `submit` lists the buttons that start a paid or free-quota job and when
 * they enable; nothing in `controls` spends anything unless it says so.
 */
export const ROUTES = [
  // ── studio ────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    path: '/home', layer: 'studio', parent: null, title: 'DreamFace – AI Avatar, Video & Image Generator All-in-One',
    via: 'open directly; sidebar "Home"',
    sections: ['heading "Create Avatars, Videos & Images"', 'agent composer', 'preset prompt chips (list "Preset prompts")', 'tool cards', '"Recreate with One Click" feed', 'floating "Customer service agent" / "Ask Dreamy Anything" / "Enter the Live"'],
    controls: [
      'composer textbox, placeholder "Add your ideas, images, or reference materials here."',
      'button "Add attachment" (shows "Video/Image") → menu "Local Upload" / "From Creations"; "From Creations" opens dialog "My Creations" whose "Confirm" stays disabled until a work is picked; Escape closes',
      'button "Ask GPT 5.6 Luna" (reads "Ask • GPT 5.6 Luna", aria-haspopup=listbox but opens a dialog "Agent Settings"): Generation Mode "Ask" (asks before each generation) / "Auto" (generates automatically); Driving Model "Claude Opus 5", "Gemini 3.5 Flash", "GPT 5.6 Luna", "GPT 5.6 Sol". Escape closes. Keep "Ask" when exploring',
      'switch "Canvas", checked by default',
      'preset chips "111222", "cecece", "Results after the triumph test", "meng", "Expand" (more: "Video Recreation", "Produce TVC Advertisement", "Product Poster", "Cinematic Short Footage"). A chip fills its own stored prompt, not its label ("meng" fills "hhh") and enables Send',
      'tool cards: "Avatar Video" → /avatar, "AI Video" → /video, "AI Image" → /image, "Video Enhance" → /apps/video-enhance, "See All" → /all-tools. Click the card button by its full name; bare text "AI Image" / "Video Enhance" also matches feed cards',
      'feed filters "All", "Social Media", "Pet", "Anime", "Beauties", "AI Image", "Chitchat", "Advertising" (stay on /home)',
      'feed card buttons open a pre-filled form, they do not submit: "Lip Sync" → /avatar?seoConfigId=<id>&seoInfoType=video, "Remix" (audio card) → /avatar?seoConfigId=<id>&seoInfoType=video_audio, "Create Video" → /video?seoConfigId=<id>&seoInfoType=image',
      'clicking a feed card body opens a detail dialog on /home (player "00:02 / 00:15", title, "Resolution", date, tag, "Remix"); its Remix is intercepted by the dialog mask; Escape closes',
      'button "Free" (top right) → paywall dialog "Get Unlimited Access" (Weekly / Annual "Save 88%" / Pay-Per-Use; Free $0 "Current Plan", Pro $29.99/Year, Premium $119.99/Year, Team). Close with its close icon; Escape is blocked',
      'unnamed avatar button → account menu: "5 free times left today", "Upgrade to Pro", "Weekly Credits (0)", "5 / 5", account email, Updates, News, Notification, Language "English", "Remove AI Watermark", "Private Mode", "Team Space", "Log Out" (never click; do not toggle settings)',
      'sidebar "Get App", "Contact Us", "API": clicking them did not leave /home and fired no request; targets not verified',
    ],
    submit: ['"Send" (aria-label Send): disabled while the composer is empty. In Ask mode it opens /canvas?projectId=<id> and the agent asks before generating; in Auto mode it may generate and spend credits'],
  },
  {
    path: '/home?type=price', layer: 'studio', parent: '/home', title: 'DreamFace – AI Avatar, Video & Image Generator All-in-One',
    via: 'open directly; SEO gallery "定价" shortcut',
    sections: ['pricing overlay over /home: Weekly / Annual / Pay-Per-Use; Free $0, Pro $29.99 /Year, Premium $119.99 /Year "Most Popular", each with "Change"'],
    controls: ['no Close control; reload (or open /home) dismisses it. Never click "Change"'],
    submit: [],
  },
  {
    path: '/canvas', layer: 'studio', parent: '/home', title: 'Dreamface Canvas | DreamFace',
    via: 'sidebar "Canvas"; open directly',
    sections: ['section nav "Canvas workspace sections": "Account Persona", "Daily Inspiration", "Content Creation"', 'right: chat aside with "Start with Some Inspiration" chips and a composer'],
    controls: [
      '"Account Persona" → "Create your Social Account Persona", button "Create Account Persona" (starts a persona build; do not click when exploring)',
      '"Daily Inspiration" → /canvas?tab=daily-inspiration: cards all named "Daily Inspiration", each with "Analyze" and "Recreate" (both start agent work)',
      '"Content Creation" → /canvas?tab=content-creation: "Create New Project", then projects with "Updated <date>" and an unnamed "Project menu"',
      'chat composer placeholder "Add your ideas, images, or reference materials here, or type @ to use tools."; "Add attachment", "Agent Settings" (disabled until loaded), "View available tools" (dialog "Tool List"), "Send"',
      'the credit count shows "0" while the page loads, then the real value',
    ],
    submit: ['"Send": disabled while empty; sits right of "View available tools", a mis-aimed click opens the tool list instead'],
  },
  {
    path: '/canvas?projectId=<id>', layer: 'studio', parent: '/canvas', title: 'Dreamface Canvas | DreamFace',
    via: 'click a project under "Content Creation"; home "Send" lands here',
    sections: ['canvas + "aside[aria-label=Chat]" with the conversation'],
    controls: ['on 2026-09-29 some existing projects rendered blank even after reload; read the conversation with dreamface/conversation instead of judging from the page'],
    submit: ['"Send" (same as /canvas). While the first reply streams a "Pause" button exists'],
  },
  {
    path: '/i-want', layer: 'studio', parent: '/home', title: 'DreamFace I Want Agent – Free AI Image, Video & Audio Generator',
    via: 'sidebar "Agent" (there is no /agent route: it 404s)',
    sections: ['left: "Agent", "Collapse", "New Chat", "Recent" with past chats', 'composer as on /canvas'],
    controls: [
      'a "Recent" chat opens read-only in place; the URL stays /i-want (no conversation id)',
      '"View available tools" → dialog "Tool List": Avatar Video (Lip Sync, Lip Sync 2.0, Dream Avatar, Dream Act), Image Generation (Text to Image, Image to Image, Nano Banana 2 / Pro, Seedream 4.0 / 4.5 / 5.0 Lite / 5.0 Pro, GPT Image 2.5 Flare / Sunburst), Image Editing (Colorize, Enhance, Outpainting, Inpainting, Swap Face, Remove Background), Video Generation (DreamVideo 1.5 / 3.0, Seedance 2.0 / 2.5 / 2.0 Fast / 2.0 Mini), Video Editing (Swap Face Video, Video Enhance, Video Matting, Video Composite, Video Translate), Audio (Voice Clone, TTS Clone, Text to Speech, TTS Pro, Voice List). Escape closes; do not click a tool',
    ],
    submit: ['"Send": disabled while empty'],
  },
  {
    path: '/avatar', layer: 'studio', parent: '/home', title: 'AI Avatar Video Generator – Make Talking Avatars Free | DreamFace',
    via: 'sidebar "Avatar"; home card "Avatar Video"; feed "Lip Sync" / "Remix" (with ?seoConfigId=…&seoInfoType=video|video_audio, pre-filled); SEO hero "Try it now on Web" (?pageType=homepage&pageId=-1)',
    sections: ['"Generate avatar videos with just one photo"', 'form top to bottom: Photos/Videos, Background, Want Avatar to Say, Voice, Animate Effect, Resolution, Generate'],
    controls: [
      '"Photos/Videos": avatar strip (some marked "Pro") ending in "More" → dialog "Choose Avatar" with tabs "All", "Mine", "anime", "man", "woman", "cat", "pet"…, search "Search an Avatar", "Confirm" (only selects). Clicking the "Photos/Videos" label opens "Upload Photos/Videos", closed by "Got It"',
      '"Background" → dialog "Choose Your Background" ("Original", images, "Confirm"); Escape closes',
      '"Want Avatar to Say": "Text" (textbox "Type or paste text here", counter "/500" for Video Lipsync, "/2000" for Avatar 3.0 Fast, "/210" for Avatar 3.0), "Audio" ("Upload Audio or Video" → "Choose From Asset" (dialog "My Asset": Uploads / Video / Audio) / "Upload From Device"; "Record" is disabled without a microphone), "Bulk Mode" → /avatar-bulk',
      'button "Voice (Suggest using our latest voice cloning)" showing "Grace" → dialog "Choose Your Voice": "Public" / "Mine", language list, filters All / Female / Male / Child / Rapid / Neutral / Celebrity, "Create new voice", "Confirm"; Escape closes the whole dialog',
      '"Animate Effect" radios: "Video Lipsync", "Avatar 3.0 Fast", "Avatar 3.0"',
      '"Resolution" (Video Lipsync only): "Max 720P" (default) and "Max 1080P Premium" — the latter opens the "Get Unlimited Access" paywall instead of selecting',
      'hidden file inputs accept jpg/jpeg/png/heic and video (avatar) and mp3/wav/ogg (audio)',
    ],
    submit: ['disabled until the script (or audio) is filled. Its label carries the cost: "Generate" (Video Lipsync), "1 Free Daily" (Avatar 3.0 Fast), "2 Generate" (Avatar 3.0)'],
  },
  {
    path: '/avatar-bulk', layer: 'studio', parent: '/avatar', title: 'Create Avatar Videos in Bulk | DreamFace',
    via: '/avatar "Bulk Mode"; All Tools "Avatar Bulk"',
    sections: ['tabs "1 Avatar, Multiple Scripts" / "1 Script, Multiple Avatars"'],
    controls: [
      'multiple scripts: "Change Avatar", "Script List 01", "Add New", "Add Text" (dialog; its "Confirm" enables once text is typed, it only adds the script), "Add Audio"',
      'multiple avatars: "Text" / "Audio", textbox, "Avatar List 01", "Add New", "Add Avatar" (reuses "Choose Avatar")',
      '"Video Limit: 0/30"',
    ],
    submit: ['"Upgrade" (disabled on a Free account)'],
  },
  {
    path: '/video', layer: 'studio', parent: '/home', title: 'AI Video Generator – Create Videos from Photos & Text | DreamFace',
    via: 'open directly; home card "AI Video"; feed "Create Video" (?seoConfigId=…&seoInfoType=image). The sidebar "Video" click is unreliable (landed on /avatar twice)',
    sections: ['tabs "Template" / "My Video" (a direct open may land on My Video)', 'bottom composer with modes "Image or Text", "Start & End Frame", "Template", "References to Video"'],
    controls: [
      '"Template": grid of template names (first "Enter the Biohazard"). A card opens a centered dialog with a player and "Go Create"; do not click Go Create',
      '"My Video": works grouped by date ("September 28", "August 21"…), each with model, prompt, "Retry", "Delete" and failure texts such as "Generation Failed" / "Credits refunded.". Retry resubmits (spends); never click Retry or Delete',
      '"Image or Text": image slot, textbox "Type or paste text here" (counter "/ 1500"), model button "Dream Video", "Setting", "AI Sound : On"',
      'model dialog "Model": "Dream Video 3.0 Beta" (from 1 credit, up to 15s), "Dream Video 1.5" ("1 Free Daily"), "Seedance 2.5", "Seedance 2.0 Mini", "Seedance 2.0"',
      '"Setting": Duration ("5s Free", "15s"), Resolution 480p / 720p, Ratio Landscape / Portrait. The Model and Setting popovers ignore Escape: reopen /video to get rid of them',
      '"Start & End Frame": "Start" / "End" slots',
      '"References to Video": "Use a template", model fixed "Vidu Q2", ratio "16:9", Setting Duration 4s / 6s / 8s, Resolution 540p / 720p / 1080p',
    ],
    submit: ['disabled while empty; label shows the cost: "1 Free Daily" (Dream Video 1.5), "1 Create" (References to Video)'],
  },
  {
    path: '/image', layer: 'studio', parent: '/home', title: 'AI Image Tools – Text to Image, Enhance, Filter & More | DreamFace',
    via: 'open directly; home card "AI Image"',
    sections: ['tabs "Template" / "My Image"', 'template categories "Animal", "Model", "Nezha", "anime", "Anime cosplay", "Home", "Superhero"…', 'bottom composer'],
    controls: [
      'textbox "Type or paste text here" plus an unnamed inspiration button next to it that fills a random prompt (Enter on it does too)',
      'model combobox "Dream Image 2.0" (radix select; click the combobox role, not its text, which is intercepted): Dream Image 2.0, GPT Image 2.5 Sunburst, GPT Image 2.5 Flare, GPT Image 2, Seedream 5.0 Pro, Seedream 4.5, Seedream 4.0, Nano Banana Pro, Nano Banana 2',
      'ratio button (default "4:3"; 1:1, 4:3, 3:4, 16:9, 9:16), combobox "Size" (1K; 2K / 4K on paid models), quality Low / Medium / High on GPT Image models',
      'a template card opens a preview dialog with "Go Create" (does not submit by itself); Escape closes',
      '"My Image": past works by date with "Retry" (resubmits, spends), "Re-edit" (only refills the prompt) and "Delete"',
    ],
    submit: ['"Create": disabled while the prompt is empty. Free on Dream Image 2.0; paid models show the cost in the label ("2 Create"), 4K and High raise it (4, 6)'],
  },
  {
    path: '/all-tools', layer: 'studio', parent: '/home', title: 'All Tools | DreamFace',
    via: 'open directly; home card "See All"',
    sections: ['"Featured Tools": Avatar Video, AI Video, AI Image', 'filter tabs "All", "Avatar", "Video", "Image", "Audio"', 'tool cards (name + badge "Hot"/"Free")'],
    controls: ['tool cards → /apps/<slug> (see children). Several share a description, and bare text "Act" matches six nodes: click by role button with the card\'s full name'],
    submit: [],
  },
  { path: '/apps/dreamact', layer: 'studio', parent: '/all-tools', title: 'DreamAct – Bring Your Photos to Life with AI Live Portrait | DreamFace', via: 'All Tools "Act"', sections: ['"Upload a reference video to make your avatar imitate the same motion."', 'motion templates ("Dorm Groove", "Studio Glow"…) each with "Go Create"', 'modes "Swap Avatar" / "Act Mimic", slots Source Video / Character Image', '"Select generation quality": Standard / Advanced / Pro'], controls: ['quality changes the cost (Standard 1, Advanced 2)'], submit: ['"Create": disabled until video and image are set; label shows the cost'] },
  { path: '/apps/ai-filter', layer: 'studio', parent: '/all-tools', title: 'AI Filter – Turn Photos into Extraordinary Art Styles | DreamFace', via: 'All Tools "AI Filter"', sections: ['only "AI Filter" / "Transform photos into extraodinary art styles" rendered on 2026-09-29, also after reload (the page payload was 69 bytes): an empty page here is the environment, not a click that failed'], controls: [], submit: [] },
  { path: '/apps/photo-enhance', layer: 'studio', parent: '/all-tools', title: 'Photo Enhance AI – Improve Image Quality and Restore Details Automatically | DreamFace', via: 'All Tools "Photo Enhance"', sections: ['"Upload Image"', '"No image? Try one of these:" sample thumbnails', 'after a run: "After" / "Before", "Upload New", "Download", "Generation completed", "Check"'], controls: [], submit: ['NO submit button: clicking a sample thumbnail runs the enhancement at once and uses a free daily use (seen: free uses 5 → 4, a PHOTO_ENHANCER work appeared). Uploading an image does the same'] },
  { path: '/apps/background-remover', layer: 'studio', parent: '/all-tools', title: 'Free One-Click Image Background Remover Tool | DreamFace', via: 'All Tools "Background Remover"', sections: ['"Upload Image"', '"No image? Try one of these:" sample thumbnails'], controls: [], submit: ['NO submit button: a sample thumbnail or an upload runs at once (same pattern as Photo Enhance)'] },
  { path: '/apps/image-detector', layer: 'studio', parent: '/all-tools', title: 'AI Image Detector – Check if a Photo is AI-Generated | DreamFace', via: 'All Tools "AI Image Detector"', sections: ['"Upload Image"', '"No image? Try one of these:" sample thumbnails'], controls: [], submit: ['NO submit button: a sample thumbnail or an upload runs at once (same pattern as Photo Enhance)'] },
  { path: '/apps/video-enhance', layer: 'studio', parent: '/all-tools', title: 'AI Video Enhancer – Upscale & Improve Video Quality | DreamFace', via: 'All Tools "Video Enhance"; home card "Video Enhance"', sections: ['"Boost your video quality with advanced AI technology."', '"Upload a Video" / "Choose File": "within 90 seconds and under 200MB"'], controls: [], submit: ['upload starts the job'] },
  { path: '/apps/voice-studio', layer: 'studio', parent: '/all-tools', title: 'AI Voice Studio – Text to Speech & Voice Cloning | DreamFace', via: 'All Tools "Voice Studio"', sections: ['tabs "Voice Clone" ("Record Your Own Voice", upload), "Text To Speech" ("AI Script", "Translate", "Match Your Voice", "Choose Your Voice" with Public / Mine and a very long voice list), "Singing Voice Conversion" ("Upload An Audio/video", categories Funny / Gaming / Cartoons / Famous / Streamers), "My Voices"'], controls: ['the voice list makes tab_read and the tree very long; read around the form with tab_find instead'], submit: ['"Generate" per tab; do not click voice samples'] },
  { path: '/apps/face-swap', layer: 'studio', parent: '/all-tools', title: 'AI Face Swap Online: Seamlessly Swap Faces in Video Clips | DreamFace', via: 'All Tools "Face Swap"', sections: ['"Videos" strip with "More" (dialog "Choose Video": All / Mine, "Confirm"; Escape closes)', '"Swap face" / "Add face"'], controls: [], submit: ['"Generate": disabled until a video and a face are set'] },
  { path: '/apps/image-watermark-remover', layer: 'studio', parent: '/all-tools', title: 'Watermark Remover – Remove Watermarks from Photos & Videos | DreamFace', via: 'All Tools "Watermark Remover" (the guessed /apps/watermark-remover redirects to /home)', sections: ['toggle "Video Watermark Remover" ("within 30s & under 100MB", max 1920×1080, .mp4 .avi .mov .mkv .webm) / "Image Watermark Remover" (JPG/JPEG/PNG below 10MB); the mode is a query parameter'], controls: [], submit: ['upload starts the job'] },
  { path: '/apps/pet-lip-sync', layer: 'studio', parent: '/all-tools', title: 'AI Pet Singing & Lip Sync Generator – Make Your Pet Sing | DreamFace', via: 'All Tools "Pet Lip Sync"', sections: ['"Photos" strip ("Pro", "More")', '"Want Pet to Sing or Say": "Song" (long song list, first "APT.(Kids\' Version)"), "Text" (voice "Thomas"), "Audio" ("Upload Audio or Video", "Record")'], controls: ['do not click songs (they play samples)'], submit: ['"Generate": looks enabled on Song with the default photo and song; disabled on empty Text / Audio'] },
  { path: '/apps/translate', layer: 'studio', parent: '/all-tools', title: 'AI Video Translator – Translate & Dub Videos Instantly | DreamFace', via: 'All Tools "Video Translator"', sections: ['"Choose a Video" / "Upload Video" (m4v, mp4, mov, webm, up to 30min)', '"Select Original Language" / "Select Output Language"', '"Lip Sync" On, "Dynamic Duration" On, "5 / 5 Free Daily"', '"No video? Try one of these:" samples'], controls: ['an onboarding tour ("Select Video" → … → "One-click Translation" / "Translate") covers the page on first visit and has no close'], submit: ['the tour\'s last step SUBMITS a translation of the sample video and jumps to /creation (seen: an AI_TRANSLATOR work started). Do not click the tour\'s Next / Translate or the samples; reload to get rid of the tour'] },
  { path: '/apps/podcast', layer: 'studio', parent: '/all-tools', title: 'AI Podcast Generator – Create Avatar-Hosted Podcasts | DreamFace', via: 'All Tools "Podcast"', sections: ['"Sample Video" player', '"Avatar Podcast"', '"AI Storytelling Assist" / "Stick to the Script", counter "0 / 1500", "Upload Audio"'], controls: [], submit: ['"Next": disabled while empty'] },
  { path: '/apps/lifetime-video', layer: 'studio', parent: '/all-tools', title: '(not recorded)', via: 'All Tools "Lifetime Video" (slug not confirmed; open it from the card)', sections: ['"Create Your Video Stroy In Minutes", "Start with a Template.": "In Memory of a Departed Loved One", "My Journey of Growth", "Celebrity Biography", "My Travel Journal"…', 'the sidebar switches to a slimmer variant'], controls: ['a template opens a preview ("Generated with 3 photos") with two buttons'], submit: ['"Advanced Create" / "Quick Create" in the template preview'] },
  { path: '/apps/mv', layer: 'studio', parent: '/all-tools', title: 'AI Cinematic MV Generator – Turn One Photo into a Music Video | DreamFace', via: 'All Tools "Cinematic MV" (landing first; "Try it now" shows the form)', sections: ['upload area "Drag your file in this area to create the split screens", "Single Person" / "Multiple Person", "Use Camera" / "Upload"', 'music ("No Time to Die 01:31"), "Select voice", "Select Gender"'], controls: [], submit: ['"10 Generate" (10 credits)'] },
  { path: '/apps/ai-sound', layer: 'studio', parent: '/all-tools', title: 'AI Sound Generator – Add AI Sound Effects to Your Videos | DreamFace', via: 'All Tools "AI Sound"', sections: ['"Choose a Video" / "Upload Video" (up to 1GB, within 30 seconds)', '"Input Audio Description"'], controls: [], submit: ['"Generate": disabled while empty'] },
  {
    path: '/creation', layer: 'studio', parent: '/home', title: 'My Creations – Manage Your AI Videos & Photos | DreamFace',
    via: 'sidebar "Creations" (the route is /creation; /creations is the SEO 404)',
    sections: ['tabs "Web Works" / "App Works" ("Nothing here yet" on this account)', 'banner "Creations queuing..." with "Fast Track" while a job runs', '"Select"', 'groups "Recent 7 Days" / "7 Days Ago", cards with a name and a timestamp ("Photo Enhance 2026-09-29 10:41:07"), "Generating..." on running ones, "+N" on multi-output works'],
    controls: [
      'hovering a card shows action buttons with no accessible names; open the card instead: it opens a detail dialog, Escape closes it',
      '"Select" switches to a selection bar "Delete", "Download", "Pro", "Cancel"; leave with "Cancel"',
      'the sidebar shows a number next to "Creations" while jobs run',
    ],
    submit: [],
  },
  // ── seo ───────────────────────────────────────────────────────────────────────────────────────────────────────────
  {
    path: '/', layer: 'seo', parent: null, title: 'Dreamface - Fast AI Video Generator at Your Fingertips',
    via: 'the origin; /zh is the Chinese copy (/en is a 404: English has no prefix)',
    sections: ['first load may show dialog "Avatar 2.0 is out now" (button "Close" works)', 'hero "Fast AI Generator at Your Fingertips": "Download on App Store", "Download on Google Play", "Install APK on Android", "Try it now on Web", "Build with DreamAPI"', 'Avatar Video / AI Video / AI Photo sections with "Try it Now" (zh "立即体验")', '"More Valuable Features"', 'footer'],
    controls: [
      'hero "Try it now on Web" is the one control that enters the studio: /avatar?pageType=homepage&pageId=-1. Section "Try it Now" / "立即体验", header "Start Now" and "Build with DreamAPI" scroll within the page',
      'header "AI Tools": a click opens /ai-tools; hovering opens the tools menu. The tools and template menus are both in the tree at once and intercept each other\'s clicks',
      'language trigger ("En" / "简") opens a 30+ item list with no Close; picking an item does not change the URL; reload clears the mask',
      'footer links leave the site: tools → www.dreamfaceapp.com (production), Android → Google Play, API → https://api.newportai.com/, Contact Us → feedback://',
    ],
    submit: [],
  },
  { path: '/ai-tools', layer: 'seo', parent: '/', title: 'AI Video & Image Generator Tools for Effortless Creation of Stunning Content', via: 'header "AI Tools" click; zh /zh/ai-tools', sections: ['"AI Tools & Features"', 'Avatar Video / AI Video / AI Photo / Other Tools card rows with "Show All …"', 'FAQ accordion'], controls: ['English "Show All Avatar Video" points to /zh/ai-tools/avatar-video'], submit: [] },
  { path: '/tools/<slug>', layer: 'seo', parent: '/', title: 'per tool', via: 'template menu: /tools/avatar-video, /tools/best-ai-avatar-video-generator, /tools/pet-video, /tools/ai-baby-podcast, /tools/dream-act, /tools/ai-hug, /tools/revive-ai, /tools/ai-wedding-photo, /tools/voice-clone, /tools/face-swap, /tools/video-enhance, /tools/ai-video-generator', sections: ['marketing pages without a form: CTAs "Create Avatar Video" / "Get Start Now" stay on the URL'], controls: [], submit: [] },
  { path: '/ai-video/<slug>', layer: 'seo', parent: '/', title: 'per effect, e.g. "AI Kissing Video Generator: Turn Photos Into Love Moments"', via: 'template menu: /ai-video/ai-kiss, /ai-video/body-shake, /ai-video/dream-goldfish; also /ai-effects/<slug>, /ai-filter/<slug>, /translate, /text-to-speech', sections: ['an embedded tool above the marketing body: "Choose Effect", "Upload Image" ("Click to upload an image"), "Try with our sample images" (zh "试用我们的示例图片")'], controls: [], submit: ['"Create" (zh "创 建", with a space) is enabled even with nothing uploaded. Sample thumbnails submit at once without a confirm'] },
  { path: '/models/<slug>', layer: 'seo', parent: '/', title: 'e.g. "Seedream AI Image Generator: Create, Edit, and Enhance Images Instantly"', via: 'footer: /models/seedream, /models/nano-banana', sections: ['tabs "Image to Image" / "Text to Image", "Select Model", upload (JPG/PNG/WEBP up to 10MB, min 300px)'], controls: [], submit: ['"Create": enabled with nothing uploaded'] },
  { path: '/gallery', layer: 'seo', parent: '/', title: 'AI生成图像和视频 - Dreamface数字创意画廊 (zh)', via: 'header "Gallery"; /zh/gallery', sections: ['search "搜索"', 'category trigger "All": Avatar Video, Pet Video, AI Video, AI Photo, Trendy Template', 'filters 全部 / 社交媒体 / 宠物 / 动画 / 美丽 / 人工智能图像 / 闲聊 / 广告', 'shortcut cards with "前往": AI工具 and 模板 → /zh/ai-tools, 图库 → /zh/gallery, 博客 → /blogpage (no /zh), 定价 → /home?type=price, API → api.newportai.com'], controls: ['detail pages /image-templates/<slug> have Download, Share, Like, "Remix" (Remix leads into generation)'], submit: [] },
  { path: '/blogpage', layer: 'seo', parent: '/', title: 'Dreamface 博客：探索 AI 视频与 AI 照片创作的未来 (zh)', via: 'header "Blog"; /zh/blogpage', sections: ['"技巧、窍门与新动态"', 'article cards → /blog/<slug> without the language prefix (so /zh/blog/<slug> is a 404)'], controls: [], submit: [] },
];

/**
 * Pitfalls met while driving the pages, most costly first. `routes` limits a trap to those pages (absent: anywhere).
 */
export const TRAPS = [
  { id: 'one-click-samples', routes: ['/apps/photo-enhance', '/apps/background-remover', '/apps/image-detector', '/apps/translate', '/ai-video/<slug>', '/models/<slug>'], symptom: 'Clicking a "Try one of these" / "Try with our sample images" thumbnail starts the job at once, with no Create button or confirm. Seen: Photo Enhance used a free daily use (5 → 4) and created a work.', fix: 'Never click sample thumbnails, template thumbnails under a tool form or uploads unless the case is meant to generate. Check the effect with dreamface/credits and dreamface/works.' },
  { id: 'tour-submits', routes: ['/apps/translate'], symptom: 'The Video Translator onboarding tour covers the page; stepping through it with "Next" ends at "One-click Translation" / "Translate", which submits the sample video and jumps to /creation (an AI_TRANSLATOR work started).', fix: 'Do not step through the tour. Reload, or leave the page, to get rid of it.' },
  { id: 'retry-resubmits', routes: ['/video', '/image'], symptom: '"Retry" next to a past work in My Video / My Image resubmits it and spends credits; "Delete" is next to it.', fix: 'Read these lists only. "Re-edit" on /image just refills the prompt.' },
  { id: 'cost-in-label', symptom: 'Submit buttons carry the price in their text: "1 Free Daily", "2 Generate", "2 Create", "10 Generate". Paid models, 4K, High quality or Advanced/Pro raise the number; Max 1080P opens a paywall.', fix: 'Assert on the label to check pricing rules; a missing number means free on this account.' },
  { id: 'sidebar-not-links', routes: ['/home', '/canvas', '/i-want'], symptom: 'Sidebar items are plain divs. Clicks often land on a neighbour (sidebar "Video" opened /avatar twice) or, when the composer has focus, type into the composer and enable Send.', fix: 'Open routes directly with their URL (studio routes: /home, /canvas, /i-want, /avatar, /video, /image, /all-tools, /creation). After any click near the composer, check that Send is still disabled before continuing.' },
  { id: 'route-names', symptom: 'Guessed studio URLs fall into the SEO site\'s 404 ("Sorry, the page you visited does not exist." / "Back Home"): /agent, /creations, /en, /template(s). /apps/watermark-remover redirects to /home.', fix: 'Sidebar "Agent" is /i-want, "Creations" is /creation, the watermark tool is /apps/image-watermark-remover. Use the paths in this map.' },
  { id: 'refs-expire', symptom: 'Refs (eN) go stale on almost every re-render (closing a banner, a hover, a streaming reply): not_found / stale_ref.', fix: 'Take a fresh tab_observe right before each ref click, or target by role + name / text from this map.' },
  { id: 'collapsed-tree', symptom: 'While a dialog or popover is open the accessibility tree collapses to one node ("generic (collapsed)" or aria-hidden) and many controls (avatar strip, templates, work actions, sidebar icons) have no names.', fix: 'Use tab_read (visible text) and tab_find by visible text; act on the ref tab_find returns.' },
  { id: 'overlays', symptom: 'Masks that intercept every click: paywall "Get Unlimited Access" (Escape blocked; its close icon worked once, not always), /video Model and Setting popovers (ignore Escape), a feed detail dialog on /home, the SEO language list, the plan sheet with "Upgrade Pro" at the top of /home.', fix: 'Try the dialog\'s "Close" / close icon, then Escape (needs a focused element), then reload or reopen the route. A reload keeps the route.' },
  { id: 'ambiguous-text', symptom: 'Short texts match many nodes: "Act" (6), "All", "Audio", "Female", "Avatar 3.0", "AI Image" (tool card and feed card), "Agent" ("Customer service agent"), "Contact Us" (a feed card).', fix: 'Use role button + the full accessible name, or scope with within.' },
  { id: 'loading-zero-credits', routes: ['/canvas', '/all-tools', '/apps/background-remover'], symptom: 'The top-right credit count shows "0" for a while on some pages.', fix: 'Wait for the real number, or compare with dreamface/credits (paid); do not report it as a balance bug without that.' },
  { id: 'blank-pages', routes: ['/home', '/canvas?projectId=<id>', '/apps/ai-filter'], symptom: '/home sometimes renders blank or a Nuxt 500 ("Unable to preload CSS …"); some /canvas?projectId pages stay blank after reload; /apps/ai-filter only renders its heading.', fix: 'Reopen from another studio route before calling it a defect; read project content with dreamface/conversation. Treat as environment unless the case is about that page.' },
  { id: 'preset-chip-text', routes: ['/home', '/canvas'], symptom: 'A preset chip fills its stored prompt, not its label ("meng" fills "hhh"), and enables Send.', fix: 'Read the composer after clicking a chip; clear it if you are not going to send.' },
  { id: 'seo-language-prefix', routes: ['/', '/blogpage', '/gallery', '/ai-tools'], symptom: 'Links drop or add /zh inconsistently: blog cards go to /blog/<slug> (so /zh/blog/<slug> 404s), gallery 博客 goes to /blogpage, English "Show All Avatar Video" goes to /zh/…, "Video Lip Sync" goes to /avatar without /zh.', fix: 'Assert the URL a link actually opens; do not build Chinese URLs by adding /zh.' },
  { id: 'production-links', routes: ['/', '/ai-tools'], symptom: 'Most header "AI Tools" items and all footer tool links point to www.dreamfaceapp.com (production), not the test origin.', fix: 'Do not follow them in a test; record the href instead.' },
  { id: 'console-noise', symptom: 'Every studio page logs "[Meta Pixel] - Duplicate Pixel ID", "google.accounts.id.initialize() is called multiple times" and "Hydration completed but contains mismatches".', fix: 'Ignore these when judging console errors.' },
];

/** Page ↔ command: where a command's data shows on the pages, and what only the page has. */
export const COMMANDS = [
  { command: 'whoami', routes: ['/home'], page: 'account menu (email, plan). free_animate_left is the "N free times left today" line', note: 'read' },
  { command: 'credits', routes: ['/home', '/canvas', '/all-tools'], page: 'top-right number = paid; free_uses_left = "5 / 5" in the account menu and the "N Free Daily" labels', note: 'read; the page may show 0 while loading' },
  { command: 'agent-models', routes: ['/home', '/canvas'], page: '"Agent Settings" → Driving Model', note: 'read' },
  { command: 'agent-tools', routes: ['/i-want', '/canvas'], page: '"View available tools" → "Tool List"', note: 'read' },
  { command: 'projects', routes: ['/canvas'], page: '"Content Creation" project list', note: 'read' },
  { command: 'conversation', routes: ['/canvas?projectId=<id>'], page: 'the chat aside of a project', note: 'read; use it when the project page renders blank' },
  { command: 'agent-chat', routes: ['/home', '/canvas', '/i-want'], page: 'composer + Send (Auto mode)', note: 'write: free daily agent use or credits' },
  { command: 'agent-image', routes: ['/home', '/canvas'], page: 'composer asking for images', note: 'write: credits' },
  { command: 'agent-video', routes: ['/home', '/canvas'], page: 'composer asking for a video', note: 'write: credits, minutes' },
  { command: 'avatars', routes: ['/avatar', '/avatar-bulk'], page: '"Choose Avatar" (the page adds categories, search and Mine)', note: 'read' },
  { command: 'voices', routes: ['/avatar', '/apps/voice-studio'], page: '"Choose Your Voice" (default "Grace")', note: 'read' },
  { command: 'avatar-video', routes: ['/avatar'], page: 'avatar, Text script, Voice, Animate Effect, Resolution, Generate', note: 'write: free daily use or credits' },
  { command: 'image-models', routes: ['/image'], page: 'model combobox, ratio, Size, quality', note: 'read' },
  { command: 'ai-image', routes: ['/image'], page: 'prompt, model, ratio, Size, Create', note: 'write: free on Dream Image 2.0, credits otherwise' },
  { command: 'ai-video', routes: ['/video'], page: '"Image or Text" mode: prompt, model, Setting, Create', note: 'write: free daily use or credits' },
  { command: 'works', routes: ['/creation', '/video', '/image'], page: '/creation Web Works, My Video, My Image (the page adds dates, failure reasons, Retry, Delete)', note: 'read' },
  { command: 'work', routes: ['/creation'], page: 'a work\'s detail dialog / download', note: 'read; the download URL is signed for about an hour' },
  { command: 'sitemap', routes: [], page: 'this map', note: 'read; does not touch the page' },
];

/** The route tree as text; `routes` (default all) is drawn from its topmost members down. */
export function tree(routes = ROUTES) {
  const included = new Set(routes.map((r) => r.path));
  const children = new Map();
  for (const r of routes) {
    const parent = included.has(r.parent) ? r.parent : null;
    children.set(parent, [...(children.get(parent) ?? []), r]);
  }
  const lines = [];
  const walk = (route, indent) => {
    const title = route.title === '(not recorded)' ? '' : `  “${route.title}”`;
    const warn = route.submit.some((s) => /^NO submit|SUBMITS/.test(s)) ? '  ⚠ runs without a Create button' : '';
    lines.push(`${indent}${route.path}${title}${warn}`);
    for (const child of children.get(route.path) ?? []) walk(child, `${indent}  `);
  };
  for (const layer of LAYERS) {
    const roots = (children.get(null) ?? []).filter((r) => r.layer === layer.layer);
    if (!roots.length) continue;
    lines.push(`[${layer.layer}] ${layer.what.split('. ')[0]}`);
    for (const root of roots) walk(root, '  ');
  }
  return lines.join('\n');
}
