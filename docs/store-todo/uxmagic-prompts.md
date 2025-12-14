# UXMAGIC Design Prompts - Threadly Store Screens

> **Design System Context** (Include in EVERY prompt)
> - Dark-mode-first: Pure black (#0f0f0f) background with subtle gray layers
> - Glassmorphism: Frosted glass panels with blur, subtle borders (rgba(255,255,255,0.1))
> - Primary accent: Purple (#9333EA) for CTAs, active states, links
> - Typography: Playfair Display (serif) for headers, Inter/system fonts for body
> - Currency: Nigerian Naira (₦ NGN)
> - Rounded corners: 8px-16px
> - Spacing rhythm: 16px/24px
> - Tag chips: Purple, Blue, Green, Orange, Red, Gray variations
> - Target: Gen-Z/Millennial fashion enthusiasts in Africa

---

## PART 1: STORE CREATION & ONBOARDING FLOW

### Screen 1.1: Store Creation - Entry Point / Welcome
```
Design a premium dark-mode welcome screen for brand store creation on Threadly - a fashion social-commerce platform.

CONTEXT:
- This is the first screen a brand sees when starting store creation
- User is already logged in with verified email/phone
- Dark aesthetic with glassmorphism effects

LAYOUT:
- Full-screen dark (#0f0f0f) background with subtle gradient overlay
- Centered glassmorphic card (max-width 600px) with frosted effect
- Top: Large illustration/icon of a storefront with purple accents
- Header: "Create Your Store" in Playfair Display, bold, white
- Subtext: "Set up your fashion brand on Threadly in minutes. Reach style-conscious shoppers across Africa."
- Progress indicator: 6 steps shown as dots (first active in purple)

ELEMENTS:
- "Get Started" primary CTA button (purple gradient, large, full-width within card)
- "Resume Draft" secondary link (if applicable, muted text)
- Checklist preview: Small glassmorphic pills showing requirements
  - "3+ Hero Products"
  - "1 Collection or Look"
  - "Store Policies"
  - "Media Standards Met"

VISUAL STYLE:
- Glassmorphism card with backdrop-blur
- Purple (#9333EA) accent for CTA and active elements
- Subtle hover glow effects
- White text on dark background
- Professional, luxury fashion aesthetic
```

---

### Screen 1.2: Store Creation - Basic Info (Step 1)
```
Design a premium dark-mode store basic info form for Threadly - a fashion social-commerce platform.

CONTEXT:
- Step 1 of 6 in store creation wizard
- Brand is entering core store identity information
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Left side (60%): Form section with glassmorphic container
- Right side (40%): Live preview card showing how store will appear

FORM FIELDS (glassmorphic inputs with subtle borders):
1. Store Name* - Text input with character counter (max 50)
2. Store Slug* - Auto-generated from name, editable, with availability check
   - Shows "@threadly.com/store/[slug]"
   - Green checkmark or red X for availability
   - "Checking..." loading state
3. Category* - Dropdown: African Fashion, Western Fashion, Streetwear, Vintage, Luxury, Sustainable
4. Tagline* - Text input (max 100 chars) "Your brand in one line"
5. Description* - Textarea (100-500 chars) with character counter

MEDIA UPLOADS:
- Logo upload: Circular dropzone with "Upload Logo" (min 400x400px)
- Banner upload: Wide rectangular dropzone "Upload Banner" (min 1200x400px)
- Both show preview thumbnails when uploaded
- Drag-and-drop with click-to-browse fallback

LIVE PREVIEW CARD (right side):
- Glassmorphic card showing banner at top
- Logo overlapping banner bottom
- Store name, tagline displayed
- "How customers will see your store" label

FOOTER:
- Progress bar (Step 1 of 6)
- "Back" text button (muted)
- "Continue" primary CTA (purple, disabled until required fields complete)
- "Save as Draft" secondary link

VISUAL STYLE:
- Inputs with dark backgrounds, subtle purple focus borders
- Real-time validation indicators
- Smooth transitions on preview updates
```

---

### Screen 1.3: Store Creation - Social & Verification (Step 2)
```
Design a premium dark-mode social links and verification screen for Threadly store creation.

CONTEXT:
- Step 2 of 6 in store creation
- Brand connects social media and optional domain verification
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Centered glassmorphic card (max-width 700px)
- Step progress at top

SOCIAL LINKS SECTION:
Title: "Connect Your Socials" with subtext "Help customers find and trust your brand"

Social input rows (each with icon + input):
- Instagram: @handle input with "Connect" button
- TikTok: @handle input with "Connect" button
- Twitter/X: @handle input with "Connect" button
- Website: URL input (https://)

Each connected account shows:
- Green checkmark
- Follower count badge if available
- "Disconnect" option

DOMAIN VERIFICATION (Optional):
- Glassmorphic expandable section
- Title: "Verify Your Domain" with trust badge icon
- Subtext: "Add a TXT record to earn a Verified Brand badge"
- Instructions accordion when expanded
- Status: "Pending" / "Verified" badge
- "Verify Later" skip option

TRUST BADGES PREVIEW:
- Row of potential badges: "Verified Domain", "Social Connected", "Fast Responder"
- Gray (locked) until criteria met, purple when earned

FOOTER:
- Progress bar (Step 2 of 6)
- "Back" and "Continue" buttons
- "Skip for Now" text link

VISUAL STYLE:
- Social media brand colors for icons
- Glassmorphic cards with hover states
- Connected state animations
```

---

### Screen 1.4: Store Creation - Policies (Step 3)
```
Design a premium dark-mode store policies setup screen for Threadly store creation.

CONTEXT:
- Step 3 of 6 in store creation
- Brand sets shipping, returns, and contact policies
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Two-column layout on desktop, stacked on mobile
- Policy cards as glassmorphic sections

SHIPPING POLICY CARD:
- Title: "Shipping Policy"
- Shipping regions: Multi-select chips (Nigeria, Ghana, Kenya, South Africa, Other)
- Processing time: Dropdown (1-2 days, 3-5 days, 5-7 days, 7-14 days)
- Shipping methods: Checkboxes (Standard, Express, Free over ₦X)
- Free shipping threshold: Currency input (optional)

RETURNS POLICY CARD:
- Title: "Returns & Exchanges"
- Returns accepted: Toggle switch
- Return window: Dropdown (7 days, 14 days, 30 days, No returns)
- Conditions: Checkboxes (Unworn, Tags attached, Original packaging)
- Size exchange: Toggle "Free size exchanges" with info tooltip

SIZE GUIDE SECTION:
- Title: "Size Guide"
- Template dropdown: "Standard US", "Standard UK", "Custom"
- "Upload Custom Size Chart" button
- Preview thumbnail

CONTACT & RESPONSE:
- Title: "Customer Contact"
- Response time SLA: Dropdown (Within 2 hours, Same day, Within 24 hours, Within 48 hours)
- Contact email: Input (pre-filled from account)
- Shows "Usually responds within X" badge preview

DEFAULTS HELPER:
- "Apply Recommended Defaults" button at top
- Info tooltip explaining industry standards

FOOTER:
- Progress bar (Step 3 of 6)
- Navigation buttons
```

---

### Screen 1.5: Store Creation - Catalog Starter (Step 4)
```
Design a premium dark-mode catalog starter screen for Threadly store creation.

CONTEXT:
- Step 4 of 6: Brand must add minimum catalog before publishing
- Requirements: 3+ hero products AND 1 collection OR look
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Header with requirements checklist
- Two main sections: Products and Collections/Looks

REQUIREMENTS HEADER:
- Glassmorphic banner showing progress
- Checklist items with status:
  - "☐ Add 3+ hero products" (0/3) - red/incomplete
  - "☐ Create 1 collection or look" (0/1) - red/incomplete
- Progress ring visualization

PRODUCTS SECTION:
- Title: "Your Products" with "Add Product" purple CTA button
- Grid of product cards (empty states initially):
  - Dashed-border placeholder cards
  - "+ Add Product" center content
  - When filled: Product thumbnail, title, price, status badge
- Product card states: Draft (gray), Active (green), Coming Soon (purple)

COLLECTIONS/LOOKS SECTION:
- Two tabs: "Collections" | "Looks"
- Tab content with similar card grid
- For Collections: Cover image, name, product count
- For Looks: Styled image, products tagged, creator name

EMPTY STATE:
- Illustration showing fashion catalog concept
- "Start building your catalog" message
- Quick action buttons: "Add Product", "Create Collection", "Style a Look"

QUICK TEMPLATES:
- "Use Starter Templates" expandable section
- Template options: "Classic Collection", "New Arrivals", "Best Sellers"

FOOTER:
- Progress bar (Step 4 of 6)
- "Continue" disabled until requirements met
- Helper text: "Complete requirements above to continue"
```

---

### Screen 1.6: Product Creation Modal/Page (From Catalog Starter)
```
Design a premium dark-mode product creation form for Threadly - a fashion social-commerce platform.

CONTEXT:
- Full-screen modal or dedicated page for adding a new product
- Fashion-specific required fields
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Sidebar (30%): Media upload section
- Main area (70%): Product details form in glassmorphic cards

MEDIA SECTION (sidebar):
- Title: "Product Images*" (min 3 required)
- Primary image dropzone (large, featured)
- Secondary images grid (2x3)
- Required shots indicator: "Front ✓", "Back ○", "Detail ○", "On-Model ○"
- "Add Video" expandable option
- Drag to reorder functionality
- Upload progress indicators

PRODUCT DETAILS CARD:
- Title*: Text input
- Description*: Rich text editor (materials, care, fit notes)
- Category*: Cascading dropdowns (Main > Sub > Type)
- Tags: Tag input with suggestions (autocomplete)

PRICING CARD:
- Price*: Currency input with ₦ prefix
- Compare at Price: Optional "Was" price for sales
- Currency: Dropdown (NGN default)

VARIANTS SECTION:
- "Has Variants" toggle
- If enabled:
  - Size options: Chip selector (XS, S, M, L, XL, XXL, One Size)
  - Color options: Color swatch selector with custom add
  - Variant matrix auto-generated
  - Per-variant: Stock count, SKU, price override

INVENTORY CARD:
- Stock quantity*: Number input
- SKU: Auto-generated or custom
- "Track inventory" toggle
- Low stock threshold: Number input
- "Allow backorders" toggle

SHIPPING CARD:
- Weight: Input with unit dropdown (kg/lb)
- Dimensions: L x W x H inputs
- Shipping regions: Inherited from store or override

ADDITIONAL INFO (collapsible):
- Materials*: Multi-select or input
- Care Instructions*: Predefined + custom
- Sustainability Claims: Checkboxes with "Upload Proof" option
- Returns Eligible*: Toggle

FOOTER:
- "Cancel" text link
- "Save as Draft" secondary button
- "Save & Add Another" secondary button
- "Save Product" primary purple CTA
```

---

### Screen 1.7: Collection Creation Modal
```
Design a premium dark-mode collection creation modal for Threadly.

CONTEXT:
- Modal for creating a new product collection
- Collections group related products for merchandising
- Dark aesthetic with glassmorphism

LAYOUT:
- Glassmorphic modal overlay on dimmed background
- Modal width: 600px max
- Scrollable content area

HEADER:
- "Create Collection" title
- Close X button

FORM CONTENT:
- Collection Name*: Text input
- Description: Textarea (optional)
- Cover Image*: Dropzone with preview (recommended 1200x600px)

COLLECTION TYPE:
- Radio/chip selector:
  - "Standard Collection"
  - "Seasonal Drop" (shows countdown options)
  - "Limited Edition" (shows quantity cap)
  - "Capsule Collection"

DROP SETTINGS (conditional, for Seasonal Drop):
- Launch Date: Date picker
- Countdown: Toggle "Show countdown on store"
- Notify followers: Toggle

PRODUCT SELECTION:
- Title: "Add Products"
- Search/filter bar
- Product grid with checkboxes for selection
- Selected products appear in a mini-list below
- Drag to reorder selected products

VISIBILITY:
- Toggle: "Featured on store homepage"
- Status: Radio (Active / Inactive)

FOOTER:
- "Cancel" link
- "Create Collection" purple CTA
```

---

### Screen 1.8: Look/Outfit Creation Modal
```
Design a premium dark-mode look/outfit creation modal for Threadly.

CONTEXT:
- Modal for creating shoppable looks (styled outfits)
- Looks feature product hotspots on images
- Dark aesthetic with glassmorphism

LAYOUT:
- Large glassmorphic modal (800px wide)
- Two-column: Image editor left, details right

LEFT COLUMN - Image/Video Upload:
- Large media dropzone
- After upload: Image with hotspot placement tool
- "Click to add product hotspot" instruction
- Hotspots appear as purple dots with product name labels
- Drag to reposition hotspots

RIGHT COLUMN - Details:
- Look Name*: Text input
- Styled By: Dropdown (Brand / Creator name)
  - If Creator: Search/select creator from list
- Description: Textarea

TAGGED PRODUCTS LIST:
- Products added via hotspots appear here
- Each shows: Thumbnail, name, price, size availability
- "Add Product" button for non-hotspot products
- Remove X for each

PRICING SUMMARY:
- "Shop the Look" total price
- Individual item prices listed
- Availability summary: "All sizes available" / "Limited sizes"

VISIBILITY:
- "Featured Look" toggle
- "Allow size swapping for similar items" toggle

FOOTER:
- "Cancel" link
- "Save Look" purple CTA
```

---

### Screen 1.9: Store Creation - Media Standards Review (Step 5)
```
Design a premium dark-mode media standards review screen for Threadly store creation.

CONTEXT:
- Step 5 of 6: System reviews uploaded media against quality standards
- Shows pass/fail status for each media item
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Header with overall status
- Grid of media items with individual status

HEADER STATUS:
- Large status indicator:
  - ✓ "All Media Meets Standards" (green badge)
  - OR "X items need attention" (orange badge)
- Subtext explaining requirements

MEDIA GRID:
Each media item card shows:
- Thumbnail image
- Status badge:
  - ✓ Passed (green)
  - ⚠ Needs Attention (orange)
  - ✗ Failed (red)
- Issue details if failed:
  - "Resolution too low (min 1200x1200)"
  - "Missing on-model shot"
  - "Image quality issues detected"
- "Replace" button for failed items
- "View Details" expandable

REQUIREMENTS CHECKLIST:
- Glassmorphic sidebar showing requirements:
  - "Minimum 1200x1200px resolution" ✓/✗
  - "At least 3 product angles" ✓/✗
  - "On-model shot included" ✓/✗
  - "Clear, professional quality" ✓/✗
  - "No watermarks or overlays" ✓/✗

QUICK FIXES:
- "Auto-enhance images" option (AI-powered)
- "Crop suggestions" for resolution issues
- Batch upload replacement

FOOTER:
- Progress bar (Step 5 of 6)
- "Back" button
- "Continue" button (disabled if critical failures)
- "Fix Later" option (keeps store in draft)
```

---

### Screen 1.10: Store Creation - Review & Publish (Step 6)
```
Design a premium dark-mode store review and publish screen for Threadly store creation.

CONTEXT:
- Final step 6 of 6: Review all store details before publishing
- Shows complete store preview with edit options
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Full store preview with section breakdowns
- Floating publish panel

STORE PREVIEW:
- Full-width banner preview
- Store header card: Logo, name, tagline, category
- Social links display
- Stats preview: "0 Followers • 0 Reviews • X Products"

SECTION REVIEWS (expandable cards):
Each section shows summary with "Edit" button:

1. Basic Info:
   - Name, slug, category, description preview
   - "Edit" link to step 1

2. Social & Verification:
   - Connected accounts list
   - Verification status
   - "Edit" link to step 2

3. Store Policies:
   - Shipping, returns, size guide summary
   - Response time SLA
   - "Edit" link to step 3

4. Catalog:
   - Product count with thumbnails
   - Collections/Looks count
   - "Edit Catalog" link

5. Media Status:
   - All passed indicator
   - "Review Media" link

READINESS CHECKLIST:
- Glassmorphic card with final checklist:
  - ✓ Basic info complete
  - ✓ Policies set
  - ✓ 3+ products added
  - ✓ 1+ collection/look
  - ✓ Media standards met
- Overall status: "Ready to Publish" or "X items remaining"

PUBLISH PANEL (floating right):
- "Submit for Review" primary purple CTA
- Subtext: "Your store will go live after moderation review (usually within 24 hours)"
- "Save & Continue Later" secondary button
- "Get Preview Link" to share with stakeholders

FOOTER:
- "Back" button
- Terms acceptance checkbox
```

---

## PART 2: STORE MANAGEMENT SCREENS

### Screen 2.1: Store Dashboard - Main Overview
```
Design a premium dark-mode store dashboard for brand owners on Threadly.

CONTEXT:
- Main dashboard view after store is live
- Shows key metrics, quick actions, and store health
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Top: Store header bar with status
- Grid of metric cards
- Activity feed and quick actions

STORE HEADER BAR:
- Store logo and name
- Status badge: LIVE (green), ON_BREAK (orange), PENDING_REVIEW (purple)
- "View Store" external link button
- "Store Settings" gear icon
- Notification bell with count badge

METRICS GRID (glassmorphic cards):
Row 1:
- Total Revenue: ₦1,234,567 (with trend arrow +12%)
- Orders: 156 this month
- Conversion Rate: 3.2%
- Average Order Value: ₦45,000

Row 2:
- Store Views: 12.4K
- Followers: 2,847 (+89 this week)
- Products: 45 active
- Reviews: 4.8★ (128 reviews)

QUICK ACTIONS:
- Row of action buttons:
  - "+ Add Product"
  - "+ Create Collection"
  - "Style a Look"
  - "Create Promo Code"

RECENT ACTIVITY FEED:
- Glassmorphic scrollable list:
  - "New order #1234 - ₦75,000" - 2 min ago
  - "John D. started following your store" - 15 min ago
  - "Product 'Summer Dress' low stock (3 left)" - 1 hour ago
  - "New 5★ review on 'Ankara Blazer'" - 3 hours ago

ALERTS SECTION:
- Important notifications:
  - "5 orders pending shipment" (action required)
  - "Media review needed for 2 products"
  - "Payout scheduled for tomorrow"

STORE HEALTH SCORE:
- Circular progress indicator: 85/100
- Breakdown: Response time, inventory health, review score
- "Improve Score" link
```

---

### Screen 2.2: Store Settings - General
```
Design a premium dark-mode store settings page for Threadly.

CONTEXT:
- Settings page for editing store information
- Organized in tabs/sections
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Left sidebar: Settings navigation
- Main area: Active settings section

SIDEBAR NAVIGATION:
- General Settings (active)
- Social & Verification
- Policies
- Payments & Payouts
- Team Members
- Notifications
- Danger Zone

GENERAL SETTINGS CONTENT:
- Glassmorphic form cards

BASIC INFO CARD:
- Store Name: Editable input with "Save" button
- Store Slug: Editable with availability check and warning about redirects
- Tagline: Editable input
- Description: Editable textarea
- Category: Dropdown

BRANDING CARD:
- Logo: Current preview with "Change Logo" button
- Banner: Current preview with "Change Banner" button
- Color scheme: Optional brand color picker

STORE STATUS:
- Current status badge
- Status controls:
  - "Go On Break" button (if LIVE)
  - "Resume Store" button (if ON_BREAK)
  - Status change history link

RESPONSE TIME SLA:
- Dropdown: Response time commitment
- Current performance display

FOOTER:
- "Discard Changes" secondary button
- "Save Changes" primary purple CTA
```

---

### Screen 2.3: Product Management - List View
```
Design a premium dark-mode product management list view for Threadly.

CONTEXT:
- Table/list view of all store products
- Bulk actions and filtering
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Top: Search, filters, and actions bar
- Main: Product table/list
- Pagination at bottom

ACTION BAR:
- Search input with icon
- Filter dropdowns: Status, Category, Stock Level
- View toggle: Grid / List
- Bulk Actions dropdown (shown when items selected)
- "+ Add Product" primary CTA

PRODUCT TABLE (glassmorphic container):
Columns:
- Checkbox (for bulk select)
- Image thumbnail
- Product Name (with SKU below)
- Category
- Price (with compare-at if sale)
- Stock (with low stock warning badge)
- Status (ACTIVE/DRAFT/ARCHIVED badges)
- Actions (Edit, Duplicate, Archive dropdown)

ROW STATES:
- Normal: Dark row
- Hover: Subtle purple highlight
- Selected: Purple left border

STATUS BADGES:
- ACTIVE: Green
- DRAFT: Gray
- COMING_SOON: Purple with countdown
- ARCHIVED: Muted gray with strikethrough

BULK ACTIONS (when selected):
- "Archive Selected"
- "Change Status"
- "Update Stock"
- "Delete" (with confirmation)

EMPTY STATE:
- Illustration
- "No products yet"
- "Add your first product" CTA

PAGINATION:
- Items per page selector
- Page numbers
- Total count
```

---

### Screen 2.4: Product Edit Page
```
Design a premium dark-mode product edit page for Threadly.

CONTEXT:
- Full product editing interface
- Shows current product with all editable fields
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Sticky header with product name and actions
- Two-column layout: Media left (30%), Details right (70%)

STICKY HEADER:
- Back arrow and "Products" breadcrumb
- Product name (editable inline)
- Status badge with dropdown to change
- Actions: "Duplicate", "Archive", "Delete"
- "Save Changes" primary CTA

MEDIA SECTION (LEFT):
- Current images grid with reorder
- Primary image highlighted
- "Replace" overlay on hover
- "Add More Images" button
- Video section if applicable
- Required shots checklist status

DETAILS SECTION (RIGHT):
Multiple glassmorphic cards:

BASIC INFO:
- Title (editable)
- Description (rich text editor)
- Category (dropdown)
- Tags (editable chips)

PRICING:
- Price input
- Compare at price
- "On Sale" badge toggle
- Currency display

VARIANTS:
- Variant table if exists
- Add/remove variants
- Per-variant stock and price

INVENTORY:
- Current stock
- Low stock threshold
- SKU
- Inventory history link

SHIPPING:
- Weight/dimensions
- Shipping regions override

ADDITIONAL:
- Materials
- Care instructions
- Returns eligibility toggle
- Sustainability claims

FOOTER:
- "Discard Changes" link
- "Save Changes" primary CTA
- Auto-save indicator
```

---

### Screen 2.5: Order Management Dashboard
```
Design a premium dark-mode order management dashboard for Threadly store owners.

CONTEXT:
- Central hub for viewing and managing all orders
- Status filtering and bulk actions
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Top stats row
- Filter/search bar
- Orders table

STATS ROW:
- Glassmorphic cards:
  - "Pending Shipment": 12 (orange)
  - "In Transit": 8 (blue)
  - "Delivered": 156 (green)
  - "Returns/Issues": 3 (red)

FILTER BAR:
- Status filter: All, Pending, Processing, Shipped, Delivered, Returned
- Date range picker
- Search by order # or customer name
- "Export" button

ORDERS TABLE:
Columns:
- Order # (clickable link)
- Customer name
- Items (count with preview)
- Total (₦ amount)
- Payment status (Paid/Pending badges)
- Fulfillment status (color-coded badges)
- Date
- Actions (View, Ship, Contact)

ROW EXPANSION:
- Click to expand order details inline
- Shows items with thumbnails
- Shipping address
- Quick action buttons

BULK ACTIONS:
- "Mark as Shipped"
- "Print Labels"
- "Send Tracking"

EMPTY STATE:
- "No orders yet" with illustration
```

---

### Screen 2.6: Order Detail Page
```
Design a premium dark-mode order detail page for Threadly.

CONTEXT:
- Full order details view
- Actions for fulfillment, refunds, communication
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Header with order info and status
- Two columns: Order content (60%) and sidebar (40%)

HEADER:
- Back arrow to orders list
- "Order #TH-12345"
- Status badge (large)
- Order date
- Actions: "Print Invoice", "Contact Customer"

LEFT COLUMN - ORDER CONTENT:
ITEMS CARD:
- Each item row:
  - Large thumbnail
  - Product name, variant (size/color)
  - Quantity
  - Price
- Subtotal line

SHIPPING INFO CARD:
- Customer name, phone
- Full address with landmark notes
- Delivery method selected
- Estimated delivery date
- Tracking number input/display
- "Mark as Shipped" CTA if pending

TIMELINE CARD:
- Order placed - timestamp
- Payment confirmed - timestamp
- Processing started - timestamp
- Shipped - timestamp (if applicable)
- Delivered - timestamp (if applicable)

RIGHT COLUMN - SIDEBAR:
CUSTOMER CARD:
- Customer name
- Email, phone
- Order history: "3rd order with you"
- "Contact" button

PAYMENT SUMMARY:
- Subtotal
- Shipping
- Tax (7.5% VAT)
- Discounts applied
- Total

ACTIONS CARD:
- "Send Tracking Update"
- "Issue Refund" (opens modal)
- "Report Issue"

NOTES CARD:
- Internal notes (editable)
- Customer notes from checkout
```

---

## PART 3: CONFIRMATION MODALS & EDGE CASES

### Screen 3.1: Publish Store Confirmation Modal
```
Design a premium dark-mode publish store confirmation modal for Threadly.

CONTEXT:
- Final confirmation before submitting store for review
- Summarizes what will happen next
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 500px)
- Dimmed overlay background

CONTENT:
HEADER:
- Icon: Store/launch illustration
- Title: "Submit Store for Review?"

BODY:
- "Your store will be reviewed by our team to ensure it meets Threadly's quality standards."
- Timeline: "Usually approved within 24 hours"

CHECKLIST SUMMARY:
- ✓ 5 products added
- ✓ 2 collections created
- ✓ All policies set
- ✓ Media standards met

WHAT HAPPENS NEXT:
- Numbered list:
  1. "Our team reviews your store"
  2. "You'll receive email notification"
  3. "Store goes live or feedback provided"

NOTIFICATION PREFERENCE:
- Checkbox: "Notify me via email when approved"
- Checkbox: "Also send push notification"

FOOTER:
- "Cancel" text button
- "Submit for Review" primary purple CTA
```

---

### Screen 3.2: Archive Product Confirmation Modal
```
Design a premium dark-mode archive product confirmation modal for Threadly.

CONTEXT:
- Confirmation when brand wants to archive a product
- Shows impact and consequences
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 450px)
- Warning styling

CONTENT:
HEADER:
- Warning icon (orange)
- Title: "Archive This Product?"

PRODUCT PREVIEW:
- Thumbnail, name, price
- Current status badge

IMPACT WARNING:
- "This product will be:"
  - Removed from your store
  - Removed from 2 collections
  - No longer purchasable

- "This product is in:"
  - "Summer Collection" (link)
  - "Featured Look #3" (link)

EXPLANATION:
- "Archived products can be restored later. All data will be preserved."

FOOTER:
- "Cancel" text button
- "Archive Product" orange warning CTA
```

---

### Screen 3.3: Delete Product Confirmation Modal (Destructive)
```
Design a premium dark-mode delete product confirmation modal for Threadly.

CONTEXT:
- Destructive action confirmation
- Requires typing confirmation
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal with red accent border
- Destructive styling

CONTENT:
HEADER:
- Red warning icon
- Title: "Permanently Delete Product?"

WARNING BANNER:
- Red background glassmorphic alert
- "This action cannot be undone"

PRODUCT PREVIEW:
- Thumbnail, name, price
- "Sold 45 times" stat

IMPACT:
- "This will permanently delete:"
  - Product and all variants
  - Product images and media
  - All reviews (23 reviews)
  - Sales history data

TYPE CONFIRMATION:
- "Type the product name to confirm:"
- Input field
- Product name shown for reference

FOOTER:
- "Cancel" text button
- "Delete Forever" red destructive CTA (disabled until name typed)
```

---

### Screen 3.4: Low Stock Warning Alert
```
Design a premium dark-mode low stock warning alert/modal for Threadly.

CONTEXT:
- Alert shown when product hits low stock threshold
- Quick restock action
- Dark aesthetic with glassmorphism

LAYOUT:
- Slide-in panel from right or modal
- Orange warning accent

CONTENT:
HEADER:
- Orange warning icon
- "Low Stock Alert"

AFFECTED PRODUCTS:
- List of products hitting threshold:
  - Product thumbnail, name
  - Current stock: "3 remaining"
  - Threshold: "Alert at 5"
  - "Update Stock" quick action each

QUICK ACTIONS:
- "Update Stock Now" - opens inline stock update
- "Adjust Threshold" - opens settings
- "Enable Back-in-Stock Notifications" toggle

DISMISS OPTIONS:
- "Remind me later"
- "Dismiss for this product"

FOOTER:
- "Manage All Inventory" link
```

---

### Screen 3.5: Store Status Change - Go On Break Modal
```
Design a premium dark-mode "Go On Break" confirmation modal for Threadly.

CONTEXT:
- Store owner wants to temporarily pause their store
- Explains what happens during break
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 500px)

CONTENT:
HEADER:
- Pause/break icon
- Title: "Take a Break?"

EXPLANATION CARD:
- "While your store is on break:"
  - ✓ Your followers will be notified
  - ✓ Your store page remains visible
  - ✓ Products will show as "Unavailable"
  - ✓ You can resume anytime
  - ✗ No new orders can be placed

OPTIONAL MESSAGE:
- "Add a note for your followers (optional):"
- Textarea: "We're taking a short break and will be back soon!"

ESTIMATED DURATION:
- "When do you plan to return?"
- Date picker (optional)
- "I'm not sure yet" checkbox

FOOTER:
- "Cancel" text button
- "Go On Break" orange CTA
```

---

### Screen 3.6: Resume Store Confirmation Modal
```
Design a premium dark-mode resume store confirmation modal for Threadly.

CONTEXT:
- Store owner resuming from break status
- Notification to followers option
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 450px)
- Positive/green accent

CONTENT:
HEADER:
- Play/resume icon (green)
- Title: "Resume Your Store?"

STATUS CHANGE:
- Visual status transition: ON_BREAK → LIVE
- "Your store has been on break for 14 days"

NOTIFICATION OPTIONS:
- Toggle: "Notify followers that you're back"
- If enabled: "We'll send a push notification to your 2,847 followers"

PROMOTIONAL MESSAGE:
- "Add a comeback message (optional):"
- Textarea: "We're back! Check out our new arrivals"

CHECKLIST:
- Auto-verify before resume:
  - ✓ Products still have inventory
  - ✓ Payment settings active
  - ⚠ "2 products need stock update" (link)

FOOTER:
- "Cancel" text button
- "Resume Store" green CTA
```

---

### Screen 3.7: Refund Order Modal
```
Design a premium dark-mode refund order modal for Threadly.

CONTEXT:
- Store owner processing a refund for an order
- Partial or full refund options
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 550px)

CONTENT:
HEADER:
- Refund icon
- Title: "Issue Refund"
- Order #TH-12345

ORDER SUMMARY:
- Items list with checkboxes for selection
- Each item: Name, variant, qty, price
- Select which items to refund

REFUND TYPE:
- Radio options:
  - "Full Refund" - ₦75,000
  - "Partial Refund" - Amount input

REFUND AMOUNT:
- Calculated total
- Breakdown: Items + Shipping (if applicable)
- "Refund shipping" checkbox

REASON:
- Dropdown: Customer request, Quality issue, Wrong item, Lost in transit, Other
- Notes textarea (optional)

REFUND DESTINATION:
- "Original payment method" (default)
- If unavailable: "Original payment expired - offer store credit?"

RESTOCK OPTIONS:
- "Restock refunded items" checkbox
- "Items already returned" checkbox

FOOTER:
- "Cancel" text button
- "Issue Refund ₦75,000" primary CTA
```

---

### Screen 3.8: Slug Change Warning Modal
```
Design a premium dark-mode slug change warning modal for Threadly.

CONTEXT:
- Warning when store owner changes their store slug
- Explains SEO impact and redirects
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 500px)
- Warning styling

CONTENT:
HEADER:
- Warning icon
- Title: "Change Store URL?"

URL PREVIEW:
- Current: threadly.com/store/old-name
- New: threadly.com/store/new-name and check mark

IMPACT EXPLANATION:
- "Changing your store URL will:"
  - Create automatic redirect from old URL
  - Update all internal links
  - May affect search engine rankings temporarily
  - Break any external links you've shared

MITIGATION:
- ✓ "We'll set up a 301 redirect from your old URL"
- ✓ "Existing bookmarks will still work"
- ⚠ "Update your social media links manually"

CONFIRMATION:
- Checkbox: "I understand the impact of this change"

FOOTER:
- "Cancel" text button
- "Change URL" warning CTA (disabled until checkbox checked)
```

---

## PART 4: CUSTOMER-FACING STORE SCREENS (Reference Designs)

### Screen 4.1: Public Store Page - Header
```
Design a premium dark-mode public store header section for Threadly.

CONTEXT:
- Top section of a brand's public store page
- Hero banner with brand card overlay
- Dark aesthetic with glassmorphism

LAYOUT:
- Full-width banner image (brand customizable)
- Glassmorphic brand card floating over banner bottom

BANNER:
- Full-width hero image (16:9 aspect on desktop, 3:2 on mobile)
- Subtle dark gradient overlay for text legibility
- Optional: Parallax scroll effect

BRAND CARD (glassmorphic floating):
- Circular brand logo (bordered in purple)
- Brand name in Playfair Display
- Location: "Lagos, Nigeria"
- Category tags as colored chips: "African Fashion", "Streetwear"
- Stats row: "5.2K followers • 4.8★ (128 reviews) • 45 products"
- Social links row: Instagram, TikTok, Website icons
- Action buttons:
  - "Follow" primary CTA (purple, changes to "Following" when active)
  - "Message Brand" secondary button
- Status badge if applicable: "Verified ✓" or "Fast Responder"

TRUST INDICATORS:
- Response time: "Usually responds within 2 hours"
- Trust badges if earned
```

---

### Screen 4.2: Public Store Page - Product Grid
```
Design a premium dark-mode product grid for a Threadly store page.

CONTEXT:
- Main product browsing area of public store
- Filterable, sortable grid
- Dark aesthetic with glassmorphism

LAYOUT:
- Sticky navigation bar below header
- Filter sidebar (collapsible on mobile)
- Responsive product grid

NAVIGATION BAR (sticky):
- Tabs: All Products | Collections | New Arrivals | Sale | About
- Search bar with filter icon
- View toggle: Grid (2-4 cols) / List
- Sort dropdown: Newest, Price ↓, Price ↑, Popular

FILTER SIDEBAR (desktop):
- Category chips: African Fashion, Western, etc.
- Price range slider: ₦0 - ₦500,000
- Gender: Male / Female / Unisex chips
- Size: XS, S, M, L, XL, XXL (multi-select chips)
- Color: Visual swatches
- "On Sale" toggle
- "Clear All" | "Apply" buttons

PRODUCT CARDS (grid):
Each card:
- Primary image (hover shows second image)
- Wishlist heart icon (top-right, glassmorphic)
- "Sale" badge if applicable (top-left, red)
- Product name
- Price: ₦25,000 (or ₦18,000 ~~₦25,000~~ if sale)
- Size availability dots: green=available, gray=out
- Quick "Add to Cart" button appears on hover
- Like and comment count icons at bottom

INFINITE SCROLL:
- Skeleton loading cards for new content
- "Loading more..." indicator

EMPTY STATE:
- "No products match your filters"
- "Clear filters" link
```

---

### Screen 4.3: Product Detail Modal/Drawer
```
Design a premium dark-mode product detail modal for Threadly.

CONTEXT:
- Full product detail view (modal or slide-in drawer)
- Purchase flow with variants and add-to-cart
- Dark aesthetic with glassmorphism

LAYOUT:
- Full-screen modal or right-slide drawer
- Two columns: Images left (50%), Details right (50%)

LEFT - IMAGE GALLERY:
- Main image (large, zoomable on hover/click)
- Thumbnail strip below for navigation
- Image counter: "1 / 5"
- Video indicator if available
- Fullscreen button

RIGHT - PRODUCT INFO:
HEADER:
- Brand name link
- Product title (large, Playfair Display)
- Price: ₦25,000 (or sale styling)
- Rating: 4.8★ (128 reviews) - clickable

SIZE SELECTOR:
- Size chips with availability:
  - Available: Purple border, selectable
  - Low stock: Orange border with "Only 2 left"
  - Sold out: Gray, crossed out
- "Size Guide" link opens modal

COLOR SELECTOR (if variants):
- Color swatches
- Selected highlighted with border

QUANTITY:
- +/- buttons with number input

ACTIONS:
- "Add to Cart" primary CTA (purple gradient, large)
- "Add to Wishlist" secondary button (heart icon)
- "Share" icon button

DELIVERY ESTIMATE:
- "Delivered by Dec 20-22"
- "Free shipping over ₦50,000" or "Shipping: ₦2,500"

EXPANDABLE SECTIONS:
- Description (expanded by default)
- Size Guide
- Materials & Care
- Shipping & Returns
- Reviews (with star breakdown)

RELATED PRODUCTS:
- Horizontal carousel at bottom
- "Complete the Look" suggestions
```

---

### Screen 4.4: Cart Drawer
```
Design a premium dark-mode cart drawer for Threadly.

CONTEXT:
- Slide-in cart from right side
- Shows cart items, totals, checkout CTA
- Dark aesthetic with glassmorphism

LAYOUT:
- Right-side glassmorphic drawer
- Dimmed overlay on page behind
- Full height, ~400px width

HEADER:
- "Your Cart" title
- Item count: "(3 items)"
- Close X button

CART ITEMS LIST (scrollable):
Each item:
- Product thumbnail (square)
- Product name (truncated)
- Variant: Size M, Black
- Quantity adjuster (+/-)
- Item price: ₦25,000
- Remove X button (subtle, shows on hover)

OUT OF STOCK WARNING (if applicable):
- Orange banner for items that became unavailable
- "Remove unavailable items" link

PROMO CODE:
- Input field + "Apply" button
- Applied code shows as chip with remove X

ORDER SUMMARY:
- Subtotal: ₦75,000
- Shipping: "Calculated at checkout" or ₦2,500
- Discount: -₦5,000 (if applied)
- Tax (7.5%): ₦5,625
- Total: ₦78,125

FOOTER:
- "Proceed to Checkout" primary CTA (purple, full-width)
- "or Continue Shopping" text link

EMPTY STATE:
- Shopping bag illustration
- "Your cart is empty"
- "Browse Products" CTA
```

---

### Screen 4.5: Checkout Page - Shipping
```
Design a premium dark-mode checkout shipping step for Threadly.

CONTEXT:
- Checkout flow step 1: Shipping address and method
- Form with address input and shipping options
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Two columns: Form (60%), Order summary sticky (40%)

PROGRESS INDICATOR:
- Steps: Shipping > Payment > Review
- Current step highlighted

SHIPPING ADDRESS FORM:
- Glassmorphic card
- Fields:
  - Full name*
  - Phone number*
  - Email*
  - Address line 1*
  - Address line 2 (optional)
  - City*
  - State/Region dropdown
  - Country (Nigeria default, dropdown for supported)
  - Postal code (if applicable)
  - Landmark/Notes (for Nigerian addresses) with helper text

SAVED ADDRESSES (if returning user):
- Radio cards for saved addresses
- "Use a new address" option

SHIPPING METHOD:
- Radio cards for options:
  - Standard (3-5 days) - ₦2,500
  - Express (1-2 days) - ₦5,000
  - Free Standard (orders ₦50,000+) - ₦0 ✓

ORDER SUMMARY (sticky sidebar):
- Item thumbnails and prices
- Subtotal, shipping, tax
- Total
- "Guaranteed by Dec 22"

FOOTER:
- "Back to Cart" link
- "Continue to Payment" primary CTA
```

---

### Screen 4.6: Checkout Page - Payment
```
Design a premium dark-mode checkout payment step for Threadly.

CONTEXT:
- Checkout flow step 2: Payment method selection
- Multiple Nigerian payment options
- Dark aesthetic with glassmorphism

LAYOUT:
- Same two-column layout as shipping step
- Payment method cards

PAYMENT METHODS:
- Glassmorphic cards for each option:

1. Card Payment:
   - Visa/Mastercard logos
   - Card number input with formatting
   - Expiry and CVV
   - "Save card for future" checkbox

2. Bank Transfer:
   - Bank icon
   - "Pay via direct bank transfer"
   - Shows account details when selected

3. USSD:
   - USSD icon
   - "Pay with USSD code"
   - Bank dropdown when selected

4. Mobile Money (if available):
   - Mobile wallet logos
   - Phone number input

5. Pay Later (BNPL):
   - Partner logo
   - "Split into 4 payments of ₦19,500"
   - "Check eligibility" link

BILLING ADDRESS:
- "Same as shipping" checkbox (default)
- Or editable form

PROMO CODE:
- Already applied shows here
- Or input to add

ORDER SUMMARY (sticky):
- Updated totals
- Selected payment method display

FOOTER:
- "Back to Shipping" link
- "Place Order ₦78,125" primary CTA
- Security badges: Encrypted, Secure payment
```

---

## PART 5: PRIVATE COLLECTIONS & ACCESS

### Screen 5.1: Private Collection Access Request
```
Design a premium dark-mode private collection access request screen for Threadly.

CONTEXT:
- User lands on a private collection they don't have access to
- Request access CTA with status display
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Blurred/locked collection preview in background
- Glassmorphic access request card centered

BACKGROUND:
- Blurred cover image of collection
- Dark overlay with lock icon pattern

ACCESS REQUEST CARD:
- Lock icon (purple)
- "This Collection is Private"
- Collection name: "Exclusive Summer Drop"
- Brand name with logo
- Brief description (if allowed)

STATUS STATES:

NOT REQUESTED:
- "Request Access" primary CTA
- "This brand will review your request"

PENDING:
- "Access Requested" badge (yellow)
- "Waiting for brand approval"
- Requested date/time
- "Cancel Request" text link

APPROVED:
- "Access Granted" badge (green)
- Collection automatically loads
- Toast: "Welcome to [Collection Name]"

REJECTED:
- "Access Not Approved" badge (red)
- "You can request again in 7 days"
- Optional rejection reason displayed

ALTERNATIVE:
- "Have an invite link?" text link
- Opens invite code input modal
```

---

### Screen 5.2: Brand - Manage Collection Access
```
Design a premium dark-mode collection access management screen for brand owners on Threadly.

CONTEXT:
- Brand owner managing who has access to private collection
- Pending requests, approved users, invite links
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Tabs: Pending Requests | Approved | Invite Links

HEADER:
- Back to collection
- Collection name
- Privacy badge: "Private Collection"
- Stats: "23 approved • 5 pending • 2 invite links active"

PENDING REQUESTS TAB:
- List of request cards:
  - User avatar and name
  - "Requested 2 hours ago"
  - User stats: "Follows 12 brands, 5 orders"
  - "Approve" green button
  - "Reject" red text button
- Bulk actions: "Approve All" | "Reject All"

APPROVED TAB:
- List of approved users:
  - Avatar, name
  - "Approved Dec 10, 2024"
  - "Via invite link" or "Via request"
  - "Revoke Access" text button (red)
- Search/filter approved users

INVITE LINKS TAB:
- "Create Invite Link" primary CTA
- Active links list:
  - Link preview (truncated)
  - "Copy" button
  - Created date
  - Expires: "in 7 days" or "Never"
  - Uses: "5 / 10 uses" or "Unlimited"
  - Status: Active / Expired
  - "Deactivate" button

CREATE INVITE MODAL:
- Expiration: Dropdown (24 hours, 7 days, 30 days, Never)
- Max uses: Input or "Unlimited" checkbox
- Note (optional): "For VIP customers"
- "Create Link" CTA
```

---

## PART 6: NOTIFICATIONS & COMMUNICATION

### Screen 6.1: Notification Center
```
Design a premium dark-mode notification center for Threadly.

CONTEXT:
- Central notifications hub for all user types
- Categorized notifications with actions
- Dark aesthetic with glassmorphism

LAYOUT:
- Dropdown panel from header bell icon
- Or full-page notifications center

HEADER:
- "Notifications" title
- Unread count badge
- "Mark all as read" link
- Settings gear icon

FILTER TABS:
- All | Orders | Social | Store (for brands)

NOTIFICATION CARDS:
Each notification:
- Icon indicating type (order, like, follow, etc.)
- Title: "New order received"
- Details: "Order #TH-12345 - ₦75,000"
- Timestamp: "2 minutes ago"
- Unread dot indicator (purple)
- Action button if applicable: "View Order", "Accept", etc.

NOTIFICATION TYPES:
Orders:
- "Order #123 confirmed"
- "Order shipped"
- "Delivery attempted"

Social:
- "John started following you"
- "Your product was liked 10 times"
- "New review on [product]"

Store (brand-specific):
- "Low stock alert"
- "Access request pending"
- "Payout processed"

EMPTY STATE:
- "You're all caught up!"
- Bell icon illustration

FOOTER:
- "View All Notifications" link (if dropdown)
- "Notification Settings" link
```

---

### Screen 6.2: Notification Preferences
```
Design a premium dark-mode notification preferences page for Threadly.

CONTEXT:
- User settings for notification channels and types
- Per-channel and per-event toggles
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Organized sections for different notification categories

CHANNELS HEADER:
- "Receive notifications via:"
- Toggle row: Email | Push | SMS (if enabled)

ORDER NOTIFICATIONS:
- "Order Updates"
- Toggle cards for:
  - Order confirmation ✓
  - Shipping updates ✓
  - Delivery confirmation ✓
  - Return status ✓

SOCIAL NOTIFICATIONS:
- "Activity & Engagement"
- Toggle cards for:
  - New followers ○
  - Likes on products ○
  - Comments and reviews ✓
  - Mentions ✓

STORE NOTIFICATIONS (brands):
- "Store Activity"
- Toggle cards for:
  - New orders ✓
  - Low stock alerts ✓
  - New followers ✓
  - Access requests ✓
  - Payout notifications ✓

PRICE & PRODUCT ALERTS:
- "Shopping Alerts"
- Toggle cards for:
  - Price drops on wishlist ✓
  - Back in stock ✓
  - New arrivals from followed brands ○
  - Sale notifications ○

QUIET HOURS:
- "Quiet Hours"
- Toggle to enable
- Start/end time pickers
- "Allow urgent order updates" checkbox

FOOTER:
- "Save Preferences" primary CTA
```

---

## PART 7: ADMIN MODERATION SCREENS

### Screen 7.1: Moderation Dashboard - Overview
```
Design a premium dark-mode admin moderation dashboard for Threadly.

CONTEXT:
- Central hub for platform moderators
- Shows pending items, queue stats, recent actions
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Top stats bar
- Queue cards grid
- Recent activity feed

HEADER:
- "Moderation Dashboard" title
- Moderator name and avatar
- Quick filters: All | Stores | Products | Reviews | Users
- "My Assignments" toggle

STATS ROW (glassmorphic cards):
- Pending Review: 47 (orange badge)
- Approved Today: 123 (green)
- Rejected Today: 8 (red)
- Appeals Pending: 3 (purple)
- Avg Response Time: 2.4 hours

QUEUE CARDS GRID:
Each queue card:
- Queue name: "Store Approvals", "Product Reviews", "User Reports"
- Pending count with urgency indicator
- Oldest item age: "Oldest: 4 hours ago"
- "Review Queue" CTA button
- Priority badges: High/Normal/Low

AUTOMATED FLAGS SECTION:
- "AI-Flagged Content"
- Cards for auto-detected issues:
  - "Potential copyright violation" (3 items)
  - "NSFW content detected" (1 item)
  - "Suspicious pricing" (5 items)
  - "Duplicate content" (2 items)

RECENT ACTIVITY FEED:
- Timeline of moderator actions:
  - "You approved Store 'Lagos Streetwear'" - 10 min ago
  - "Sarah rejected Product 'Fake Designer'" - 25 min ago
  - "System flagged 3 new items for review" - 1 hour ago

SHORTCUTS:
- Quick action buttons:
  - "Review Oldest"
  - "High Priority Queue"
  - "My Pending"
```

---

### Screen 7.2: Store Review Queue
```
Design a premium dark-mode store review queue for Threadly moderators.

CONTEXT:
- Queue of stores pending moderation approval
- Detailed review interface with approve/reject actions
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Left: Store list (30%)
- Right: Selected store detail (70%)

LEFT - STORE QUEUE LIST:
- Filter bar: Status, Age, Priority
- Sort: Oldest First, Priority, Recent
- Store cards in scrollable list:
  - Store logo and name
  - Submitted: "2 hours ago"
  - Category badge
  - Priority indicator (red/orange/green dot)
  - "Assigned to me" badge if applicable

RIGHT - STORE DETAIL PANEL:
HEADER:
- Store name and logo (large)
- "Pending Review" status badge
- "Assign to Me" button
- Quick actions: "Approve" (green), "Reject" (red)

CHECKLIST (auto-validated):
- ✓ Required fields complete
- ✓ Logo meets requirements
- ✓ Banner meets requirements
- ⚠ Description needs review (flagged)
- ✓ At least 3 products
- ✓ Policies set

STORE PREVIEW:
- Embedded preview of public store page
- "Open Full Preview" link

BRAND INFO:
- Owner name, email, phone
- Account age: "Member since Oct 2024"
- Other stores: "None" or list
- Verification status

PRODUCTS PREVIEW:
- Grid of product thumbnails
- "View All Products" link

RED FLAGS (if any):
- Automated detection results:
  - "Similar to suspended store X" 
  - "High-risk category"
  - "New account"

MODERATION NOTES:
- Previous moderator notes (if any)
- Add note textarea

DECISION PANEL:
- "Approve" green button
- "Request Changes" orange button (opens feedback modal)
- "Reject" red button (opens reason modal)

HISTORY:
- Submission history if resubmitted
```

---

### Screen 7.3: Product Review Queue
```
Design a premium dark-mode product review queue for Threadly moderators.

CONTEXT:
- Queue of products pending approval
- Image/content review with policy checks
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Split view: Queue list left, Product detail right

LEFT - PRODUCT QUEUE:
- Filters: Store, Category, Flag Type, Age
- Product cards:
  - Thumbnail
  - Product name
  - Store name
  - "Flagged: Copyright" or "New listing"
  - Age: "3 hours ago"

RIGHT - PRODUCT REVIEW:
IMAGE GALLERY:
- Large primary image
- Thumbnail strip
- Image analysis badges:
  - "Original ✓" or "Potential duplicate"
  - "NSFW scan: Clear"
  - "Resolution: OK"

PRODUCT INFO:
- Title, description (full text)
- Price: ₦25,000
- Category: African Fashion > Dresses
- Tags list

POLICY CHECKS:
- Prohibited items check: ✓ Pass
- Pricing policy: ✓ Pass
- Description quality: ⚠ Review needed
- Image requirements: ✓ Pass

COMPARISON (if flagged duplicate):
- Side-by-side with similar product
- Similarity score: 85%
- "Mark as Original" / "Mark as Copy"

STORE CONTEXT:
- Store name, status
- Store history: "12 products, 2 rejected"
- Owner info

DECISION:
- "Approve" button
- "Request Edits" button (select issues)
- "Reject" button (select reason from dropdown)
- "Escalate" button (for complex cases)
```

---

### Screen 7.4: User/Content Reports Queue
```
Design a premium dark-mode user reports queue for Threadly moderators.

CONTEXT:
- Queue of user-submitted reports on content/users
- Detailed report review with evidence
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Report list and detail split view

LEFT - REPORTS LIST:
- Filters: Report Type, Severity, Status
- Report cards:
  - Report type icon (content, user, review, etc.)
  - "Spam Report" or "Harassment"
  - Reported item preview
  - Reporter info
  - "2 hours ago"
  - Severity badge

RIGHT - REPORT DETAIL:
REPORT INFO:
- Report type: "Inappropriate Content"
- Reported by: User avatar and name
- Date: Dec 14, 2024
- Reason selected: "Misleading photos"
- Additional comments from reporter

REPORTED CONTENT:
- Full content display (product/review/user profile)
- Media gallery if applicable
- Content metadata

REPORT HISTORY:
- "This item has been reported 3 times"
- Previous reports and outcomes

EVIDENCE:
- Reporter's screenshots or notes
- AI-generated analysis
- Similar reports pattern

REPORTED USER/SELLER INFO:
- Profile summary
- Account age, history
- Previous violations: "1 warning, 0 suspensions"

ACTIONS:
- "Dismiss Report" - No violation
- "Issue Warning" - Send warning to violator
- "Remove Content" - Takedown
- "Suspend Account" - Temporary (select duration)
- "Ban Account" - Permanent (requires confirmation)

COMMUNICATE:
- "Message Reporter" button
- "Message Reported User" button
```

---

### Screen 7.5: Appeals Management
```
Design a premium dark-mode appeals management screen for Threadly moderators.

CONTEXT:
- Queue of appeals from users/brands against moderation decisions
- Review original decision and appeal arguments
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Appeals list with detail panel

LEFT - APPEALS LIST:
- Filters: Type (Store, Product, Account), Age, Status
- Appeal cards:
  - Appellant name/store
  - Appeal type: "Product Rejection Appeal"
  - Submitted: "1 day ago"
  - Original decision: "Rejected"
  - SLA indicator: "Due in 24 hours"

RIGHT - APPEAL DETAIL:
ORIGINAL DECISION:
- What was decided: "Product rejected"
- When: Dec 12, 2024
- By: Moderator name
- Reason given: "Misleading product images"
- Evidence cited

APPEAL SUBMISSION:
- Appellant statement (full text)
- Supporting evidence uploaded
- "Why I believe this was wrong" narrative
- Attachments: Images, documents

COMPARISON VIEW:
- Before (original content)
- After (if edited and resubmitted)
- Changes highlighted

POLICY REFERENCE:
- Link to relevant policy section
- Similar cases for reference

REVIEW HISTORY:
- Timeline of the case
- All moderator notes

DECISION OPTIONS:
- "Uphold Decision" - Appeal denied, explain why
- "Overturn Decision" - Reinstate content
- "Partial Overturn" - Modify original decision
- "Request More Info" - Ask appellant for clarification

COMMUNICATION:
- Template response dropdown
- Custom message editor
- "Notify Appellant" toggle
```

---

### Screen 7.6: Moderation Action - Reject Modal
```
Design a premium dark-mode rejection modal for Threadly moderation actions.

CONTEXT:
- Modal for rejecting stores/products/content
- Structured reason selection with explanation
- Dark aesthetic with glassmorphism

LAYOUT:
- Centered glassmorphic modal (max-width 550px)
- Red accent styling

HEADER:
- Warning icon (red)
- "Reject [Item Name]?"
- Item thumbnail and type indicator

REASON SELECTION:
- Radio options with descriptions:
  - "Policy Violation" → sub-options expand
    - Prohibited content
    - Misleading claims
    - Copyright infringement
    - Inappropriate images
  - "Quality Standards Not Met"
    - Image quality
    - Description incomplete
    - Missing required info
  - "Suspected Fraud"
    - Fake products
    - Price manipulation
    - Account abuse
  - "Other" → freeform text

EXPLANATION TO USER:
- "Message to seller/user:"
- Textarea with template suggestions
- "Include specific feedback" helper text
- "This will be visible to the user"

REQUIRED CHANGES (optional):
- Checklist of specific fixes needed
- "Must replace primary image"
- "Must update description"
- "Must verify authenticity"

INTERNAL NOTES:
- "Internal notes (not visible to user):"
- Textarea for moderator records

SEVERITY:
- "Is this a warning?" toggle
- If warning: "Add strike to account" checkbox
- Strike count: "This will be strike 1 of 3"

FOOTER:
- "Cancel" text button
- "Reject & Notify" red CTA
```

---

### Screen 7.7: Bulk Moderation Actions
```
Design a premium dark-mode bulk moderation screen for Threadly.

CONTEXT:
- Batch processing multiple items at once
- Quick approve/reject workflows
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Grid of selectable items
- Floating action bar when items selected

HEADER:
- "Bulk Review Mode"
- Toggle: "Quick Review" / "Detailed Review"
- Filters: Type, Status, Date range

ITEM GRID:
- Card grid of pending items
- Each card:
  - Checkbox for selection
  - Thumbnail
  - Title (truncated)
  - Type badge (Store/Product/Review)
  - Quick indicators: AI flags, age
- "Select All" / "Deselect All"

FLOATING ACTION BAR (when items selected):
- "X items selected"
- "Approve All" green button
- "Reject All" red button (opens bulk reason modal)
- "Assign to Me" button
- "Clear Selection"

QUICK REVIEW MODE:
- Swipe-style review of items one by one
- Large preview card
- Keyboard shortcuts: A=Approve, R=Reject, S=Skip
- Progress: "12 of 47 reviewed"

BULK REASON MODAL:
- Common reason selection
- Apply same reason to all selected
- Option to add individual notes
- Confirmation count: "This will reject 15 items"

COMPLETION SUMMARY:
- After bulk action:
  - "15 items approved"
  - "3 items rejected"
  - "2 items skipped"
- "Generate Report" option
```

---

## PART 8: ANALYTICS DASHBOARDS

### Screen 8.1: Brand Analytics - Overview Dashboard
```
Design a premium dark-mode analytics dashboard for brand owners on Threadly.

CONTEXT:
- Comprehensive analytics for store performance
- Key metrics, trends, and insights
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Date range selector at top
- Metric cards grid
- Charts section
- Top performers tables

HEADER:
- "Analytics" title
- Store name displayed
- Date range picker: Today, 7 days, 30 days, 90 days, Custom
- "Export Report" button
- "Compare to previous period" toggle

KEY METRICS ROW:
- Glassmorphic cards with sparkline trends:
  - Revenue: ₦2,450,000 (+15% ▲)
  - Orders: 234 (+8% ▲)
  - Visitors: 12,500 (-3% ▼)
  - Conversion Rate: 1.87% (+0.2% ▲)
  - Avg Order Value: ₦45,000 (+5% ▲)
  - Return Rate: 4.2% (stable)

REVENUE CHART:
- Large area chart showing revenue over time
- Comparison line for previous period
- Hover for daily details
- Toggle: Revenue / Orders / Visitors

TRAFFIC SOURCES:
- Pie/donut chart:
  - Direct: 35%
  - Social (Instagram): 28%
  - Search: 20%
  - Referral: 12%
  - Other: 5%

FUNNEL VISUALIZATION:
- Store Views → Product Views → Add to Cart → Checkout → Purchase
- Conversion rates between each step
- Drop-off percentages

TOP PRODUCTS TABLE:
- Rank, Thumbnail, Product Name
- Revenue, Units Sold
- Views, Conversion Rate
- Trend arrow

TOP COLLECTIONS:
- Similar table for collections

GEOGRAPHIC MAP (simplified):
- Orders by region in Nigeria
- Top cities list
```

---

### Screen 8.2: Brand Analytics - Product Performance
```
Design a premium dark-mode product performance analytics page for Threadly.

CONTEXT:
- Detailed analytics for individual products
- Views, sales, returns analysis
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Product selector/filter at top
- Detailed metrics and charts

HEADER:
- "Product Analytics" title
- Product search/dropdown selector
- Date range picker
- Compare products toggle

SELECTED PRODUCT CARD:
- Large product image
- Product name, price
- Status badge
- Quick stats: Total Revenue, Units Sold, Current Stock

PERFORMANCE METRICS:
- Views: 4,500 (graph)
- Add to Cart Rate: 12% (vs 8% avg)
- Purchase Rate: 3.2%
- Wishlist Adds: 234
- Returns: 5 (2.1%)

SALES TREND CHART:
- Line chart over selected period
- Units sold per day/week
- Revenue overlay option

VARIANT BREAKDOWN:
- Table showing performance by variant:
  - Size/Color
  - Units Sold
  - Revenue
  - Stock Remaining
  - Return Rate
- Heat map showing popular combinations

TRAFFIC SOURCES:
- How customers found this product:
  - Store page: 45%
  - Direct link: 25%
  - Collection: 18%
  - Search: 12%

CUSTOMER BEHAVIOR:
- Avg time on product page
- Scroll depth
- Image views distribution
- "Customers also viewed" products

REVIEWS SNAPSHOT:
- Average rating: 4.6★
- Rating distribution bar
- Recent review snippets
- Sentiment analysis: Positive 85%

RECOMMENDATIONS:
- AI-generated insights:
  - "Size M sells 40% more than L - consider restocking"
  - "Price is 10% higher than similar products"
  - "Add video to increase conversion by ~15%"
```

---

### Screen 8.3: Brand Analytics - Customer Insights
```
Design a premium dark-mode customer insights page for Threadly brand analytics.

CONTEXT:
- Demographics, behavior, and segment analysis
- Customer journey visualization
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Segment cards at top
- Demographic charts
- Customer journey flow

CUSTOMER SEGMENTS:
- Glassmorphic segment cards:
  - New Customers: 45% of orders
  - Returning: 35%
  - VIP (3+ orders): 20%
- Click to filter data by segment

DEMOGRAPHICS:
- Age distribution bar chart
- Gender split donut
- Location map (Nigerian states)
- Device breakdown: Mobile 78%, Desktop 22%

TOP CUSTOMER TABLE:
- Top 10 customers by revenue
- Avatar, name (anonymized option)
- Total orders, total spent
- Last order date
- "Loyalty tier" badge

CUSTOMER JOURNEY:
- Sankey diagram or flow chart:
  - Discovery → First Visit → Browse → Cart → Purchase → Repeat
- Drop-off rates at each stage

COHORT ANALYSIS:
- Retention chart by signup month
- Purchase frequency distribution
- Time between orders histogram

LOYALTY DISTRIBUTION:
- Tiers breakdown:
  - Bronze: 5,000 customers
  - Silver: 1,200 customers
  - Gold: 450 customers
  - Platinum: 50 customers

ENGAGEMENT METRICS:
- Followers trend over time
- Engagement rate (likes, comments per product)
- Wishlist activity

INSIGHTS PANEL:
- AI-generated insights:
  - "25% of first-time buyers became repeat customers"
  - "Lagos customers have 20% higher AOV"
  - "Mobile users convert 15% less - optimize mobile experience"
```

---

### Screen 8.4: Platform Analytics - Admin Dashboard
```
Design a premium dark-mode platform analytics dashboard for Threadly administrators.

CONTEXT:
- Platform-wide metrics for admins
- GMV, user growth, health metrics
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Executive summary cards
- Multi-chart dashboard
- Alerts and anomalies section

HEADER:
- "Platform Analytics" title
- Date range selector
- "Download Report" button
- Real-time indicator dot

EXECUTIVE SUMMARY:
- Large glassmorphic cards:
  - GMV (Gross Merchandise Value): ₦125,000,000
  - Active Users: 45,000 (+12%)
  - Active Stores: 1,250 (+8%)
  - Orders Today: 2,340
  - Revenue (Platform Fee): ₦6,250,000

GROWTH CHARTS:
- Multi-line chart:
  - Users (cumulative)
  - Stores (cumulative)
  - Orders (daily)
- Toggle between metrics

MARKETPLACE HEALTH:
- Order success rate: 98.2%
- Avg delivery time: 3.2 days
- Dispute rate: 0.8%
- Refund rate: 3.5%

CATEGORY BREAKDOWN:
- Pie chart of GMV by category
- African Fashion: 45%
- Streetwear: 25%
- Luxury: 15%
- Other: 15%

TOP STORES TABLE:
- Rank by GMV
- Store name, category
- Orders, revenue, growth %
- Status badge

MODERATION STATS:
- Items reviewed today: 234
- Approval rate: 92%
- Avg review time: 2.4 hours
- Active moderators: 5

ALERTS:
- Red flag items:
  - "Payment failure rate spike (+5%)"
  - "High return rate in Streetwear category"
  - "3 stores flagged for review"

REAL-TIME FEED (optional):
- Live order ticker
- New store registrations
- Large orders (>₦100,000)
```

---

### Screen 8.5: Sales Reports Generator
```
Design a premium dark-mode sales report generator for Threadly.

CONTEXT:
- Custom report builder for brands/admins
- Flexible date ranges and metrics
- Export functionality
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Report configuration panel
- Preview section
- Export options

HEADER:
- "Generate Report" title
- Saved reports dropdown
- "Save Report Template" button

CONFIGURATION PANEL:
REPORT TYPE:
- Radio options:
  - Sales Summary
  - Product Performance
  - Customer Analysis
  - Inventory Report
  - Payout Statement

DATE RANGE:
- Preset: Today, Yesterday, Last 7 days, Last 30 days, This Month, Last Month, Custom
- Custom date pickers

METRICS TO INCLUDE:
- Checkbox list:
  - ☑ Revenue
  - ☑ Orders
  - ☑ Units Sold
  - ☐ Returns
  - ☑ Avg Order Value
  - ☐ Discount Usage
  - ☐ Tax Breakdown

GROUP BY:
- Dropdown: Day, Week, Month, Product, Category, Region

FILTERS:
- Product category
- Order status
- Payment method
- Customer segment

PREVIEW SECTION:
- Live preview of report table
- Chart preview if applicable
- "Generating preview..." loading state

EXPORT OPTIONS:
- Format: CSV, Excel, PDF
- "Email Report" toggle with recipient input
- "Schedule Recurring" option:
  - Daily, Weekly, Monthly
  - Recipients list
  - Time of delivery

FOOTER:
- "Reset" text link
- "Generate Report" primary CTA
```

---

## PART 9: CREATOR DASHBOARD SCREENS

### Screen 9.1: Creator Dashboard - Overview
```
Design a premium dark-mode creator dashboard for Threadly influencers/affiliates.

CONTEXT:
- Main dashboard for creator program participants
- Shows earnings, performance, quick actions
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Creator header with status
- Earnings and metrics cards
- Activity and performance sections

CREATOR HEADER:
- Large avatar with verification badge
- Creator name and tier: "Rising Creator ⭐⭐"
- Follower count: 12.5K
- Total earnings: ₦450,000
- "View Public Profile" link
- "Edit Profile" button

EARNINGS SUMMARY (primary cards):
- This Month: ₦125,000 (with trend)
- Pending Payout: ₦85,000
- All-Time Earnings: ₦450,000
- "Request Payout" CTA button

PERFORMANCE METRICS:
- Glassmorphic cards:
  - Click-through Rate: 4.2%
  - Conversion Rate: 2.8%
  - Total Clicks: 5,400
  - Total Conversions: 152

QUICK ACTIONS:
- "Create Affiliate Link" purple CTA
- "Style a New Look" button
- "Share to Social" button
- "View Analytics" button

TOP PERFORMING CONTENT:
- Cards showing creator's best content:
  - Look image thumbnail
  - Title: "Summer Vibes Outfit"
  - Revenue generated: ₦45,000
  - Clicks: 1,200
  - Conversions: 34

BRAND PARTNERSHIPS:
- Active collaborations:
  - Brand logo, name
  - Campaign: "Holiday Collection"
  - Earnings from brand: ₦50,000
  - Status: Active / Completed

NOTIFICATIONS:
- Recent activity list:
  - "New conversion! +₦2,500 commission"
  - "Brand 'Lagos Style' wants to collaborate"
  - "Your look was featured on homepage"

TIER PROGRESS:
- Progress bar to next tier
- "2,500 more conversions to reach Established tier"
- Benefits of next tier listed
```

---

### Screen 9.2: Creator - Affiliate Links Management
```
Design a premium dark-mode affiliate links management page for Threadly creators.

CONTEXT:
- Create and manage affiliate links/codes
- Track performance per link
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Create link section at top
- Links table/list below

HEADER:
- "Your Affiliate Links" title
- Total links: 24 active
- "Create New Link" primary CTA

CREATE LINK SECTION:
- Glassmorphic card:
  - Link Type: Product / Collection / Store / Custom
  - Search/select target item
  - Custom UTM parameters (optional)
  - Promo code option:
    - Toggle: "Include promo code"
    - Code input (auto-generated or custom)
    - Discount: Amount or percentage
  - Expiration: Optional date picker
- "Generate Link" button
- Preview of generated link with copy button

LINKS TABLE:
Columns:
- Link name/target (with thumbnail)
- Short URL (copyable)
- Clicks
- Conversions
- Revenue
- Status (Active/Expired)
- Actions (Copy, Edit, Delete, Stats)

LINK CARD VIEW (alternative):
- Each link as a glassmorphic card
- QR code for each link
- Performance sparkline
- Quick copy button

PROMO CODES SECTION:
- Separate tab or section
- Code, discount amount
- Uses: 45/100 or unlimited
- Expiry date
- Associated products/stores

BULK ACTIONS:
- "Export Links" button
- "Pause All" option
- "Delete Expired" cleanup

EMPTY STATE:
- "No affiliate links yet"
- "Create your first link and start earning"
```

---

### Screen 9.3: Creator - Looks/Content Studio
```
Design a premium dark-mode content studio for Threadly creators.

CONTEXT:
- Where creators style and publish shoppable looks
- Content creation and management
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Content grid with filtering
- Create new CTA prominent

HEADER:
- "Your Looks" title
- Stats: "23 looks published, ₦250,000 earned"
- View toggle: Grid / List
- "Create New Look" primary CTA

FILTER BAR:
- Status: All, Published, Draft, Scheduled
- Sort: Recent, Performance, Earnings
- Search

LOOKS GRID:
Each look card:
- Main image/video thumbnail
- "Published" or "Draft" badge
- Look title
- Products count: "5 products"
- Performance (if published):
  - Views: 1,200
  - Purchases: 45
  - Earnings: ₦12,500
- Actions: Edit, Duplicate, Analytics, Delete

SCHEDULE INDICATOR:
- If scheduled: "Goes live Dec 20 at 9:00 AM"
- Edit schedule option

FEATURED BADGE:
- "Featured on Homepage" badge for selected looks
- Feature count: "3 of your looks are featured"

COLLAB LOOKS:
- Section for brand collaboration content
- Brand logo badge on cards
- "Contracted" indicator

CREATE FLOW PREVIEW:
- When clicking "Create New Look":
  - Opens look creation modal (Screen 1.8)
  - Or dedicated studio page

CONTENT TIPS:
- Glassmorphic tips card:
  - "Looks with video get 2x more views"
  - "Tag 3-5 products for best conversion"
  - "Post during peak hours (6-9 PM)"
```

---

### Screen 9.4: Creator - Earnings & Payouts
```
Design a premium dark-mode earnings and payouts page for Threadly creators.

CONTEXT:
- Detailed earnings breakdown
- Payout history and settings
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Earnings summary at top
- Transaction history
- Payout settings

EARNINGS HEADER:
- Large balance display: "₦85,000 Available"
- "Request Payout" primary CTA (if above minimum)
- Next auto-payout: "Dec 25, 2024"

EARNINGS BREAKDOWN:
- Glassmorphic cards:
  - Affiliate Commissions: ₦65,000
  - Look Sales: ₦15,000
  - Brand Partnerships: ₦5,000
- Period selector: This month / Last month / All time

EARNINGS CHART:
- Line chart showing earnings over time
- Toggle by source type
- Monthly/weekly view

TRANSACTIONS TABLE:
Columns:
- Date
- Type (Commission, Partnership, Bonus)
- Source (Product name or Brand)
- Amount (₦)
- Status (Confirmed, Pending, Paid)

TRANSACTION DETAIL (expandable):
- Order ID reference
- Customer location (anonymized)
- Commission rate applied
- Calculation breakdown

PAYOUT HISTORY:
- List of completed payouts:
  - Date, Amount, Method
  - Status: Processing, Completed, Failed
  - "View Receipt" link

PAYOUT SETTINGS CARD:
- Preferred method: Bank Transfer
- Bank details (masked): **** **** 4521
- Minimum payout: ₦10,000
- Payout schedule: Monthly / Bi-weekly / Weekly
- "Edit Payout Settings" button

TAX DOCUMENTS:
- "Download Tax Statement" for year
- Commission summary document
```

---

### Screen 9.5: Creator - Analytics
```
Design a premium dark-mode creator analytics page for Threadly.

CONTEXT:
- Performance analytics specific to creator content
- Audience insights and content performance
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Key metrics at top
- Performance charts
- Content breakdown

DATE RANGE:
- Selector: Last 7 days, 30 days, 90 days, Custom

KEY METRICS:
- Large cards:
  - Total Reach: 125,000
  - Engagement Rate: 8.5%
  - Click-through Rate: 4.2%
  - Conversions: 152
  - Revenue Generated: ₦380,000

REACH & ENGAGEMENT CHART:
- Dual-axis chart:
  - Reach (line)
  - Engagement (bars)
- Daily/weekly breakdown

CONTENT PERFORMANCE TABLE:
- All looks/content ranked:
  - Thumbnail, title
  - Reach, clicks, conversions
  - Revenue, commission earned
  - Trend (up/down arrows)

AUDIENCE INSIGHTS:
- Demographics of engaged users:
  - Age groups chart
  - Gender split
  - Top locations
  - Active times (heat map)

TOP PRODUCTS:
- Products you've promoted that sold best:
  - Product image, name
  - Your conversions
  - Your commission
  - Product rating

REFERRAL SOURCES:
- Where your traffic comes from:
  - Instagram: 45%
  - TikTok: 30%
  - Direct: 15%
  - Other: 10%

COMPARISON:
- Your performance vs. tier average:
  - "Your CTR is 20% above average"
  - "Conversion rate: On par with tier"

INSIGHTS & TIPS:
- AI-generated recommendations:
  - "Your evening posts perform 35% better"
  - "Add more affordable items ($$$-$$) to increase conversions"
```

---

### Screen 9.6: Creator Application Form
```
Design a premium dark-mode creator application form for Threadly.

CONTEXT:
- Application for users wanting to join creator program
- Multi-step form with social verification
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Progress stepper at top
- Form sections in glassmorphic cards

HEADER:
- "Join the Creator Program" title
- Benefits summary: "Earn commissions, collaborate with brands, grow your audience"
- Progress: Step 1 of 4

STEP 1 - BASIC INFO:
- Profile photo upload
- Display name
- Bio/about (500 chars max)
- Categories you focus on: Multi-select chips
  - African Fashion, Streetwear, Luxury, Sustainable, etc.
- Content style: Lookbooks, Try-ons, Reviews, Styling tips

STEP 2 - SOCIAL VERIFICATION:
- "Connect your social accounts"
- Instagram: Connect button → OAuth flow
  - Shows follower count after connect
- TikTok: Connect button
- YouTube: Connect button (optional)
- Twitter/X: Connect button (optional)
- Minimum requirement indicator: "500+ followers required"

STEP 3 - CONTENT SAMPLES:
- "Show us your best work"
- Upload 3-5 content samples (images/videos)
- Optional: Links to existing content
- Portfolio URL (optional)

STEP 4 - REVIEW & SUBMIT:
- Summary of application
- Terms and conditions checkbox
- "How did you hear about us?" dropdown
- Expected commitment level: Casual / Part-time / Full-time

APPLICATION STATUS (after submit):
- "Application Submitted!"
- "We'll review your application within 3-5 business days"
- "You'll receive an email with our decision"
- Status tracking available in account

FOOTER:
- "Back" button
- "Continue" / "Submit Application" CTA
```

---

## PART 10: LOYALTY & GAMIFICATION SCREENS

### Screen 10.1: Customer Loyalty Dashboard
```
Design a premium dark-mode loyalty dashboard for Threadly customers.

CONTEXT:
- Customer view of their loyalty status
- Points balance, tier, and rewards
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Tier status card at top
- Points and activity sections
- Available rewards

TIER STATUS CARD (hero):
- Large tier badge with animation
- Current tier: "Gold Member ⭐⭐⭐"
- Points balance: "15,450 points"
- Progress to next tier: Progress bar with "4,550 points to Platinum"
- Tier benefits summary

POINTS SUMMARY:
- Glassmorphic cards:
  - Available Points: 15,450
  - Points Expiring Soon: 2,000 (in 30 days)
  - Lifetime Points: 45,000
  - "View Points History" link

EARNING OPPORTUNITIES:
- Ways to earn more points:
  - "Write a review" → +50 points
  - "Share a product" → +10 points
  - "Refer a friend" → +500 points
  - "Complete your profile" → +100 points (one-time)

AVAILABLE REWARDS:
- Scrollable reward cards:
  - Reward image/icon
  - Title: "₦500 Off Next Order"
  - Points cost: 2,000 points
  - "Redeem" button
- Categories: Discounts, Free Shipping, Exclusive Products

STREAK & BADGES:
- Current streak: "7 day streak 🔥"
- Streak reward: "+50 bonus points tomorrow"
- Earned badges grid

TIER BENEFITS COMPARISON:
- Expandable section showing all tiers
- Current tier highlighted
- Benefits per tier: Bonus points %, free shipping, early access, etc.

POINTS EXPIRY WARNING:
- If points expiring soon:
  - Alert banner: "2,000 points expire in 30 days - use them now!"
  - "Browse Rewards" CTA
```

---

### Screen 10.2: Rewards Catalog
```
Design a premium dark-mode rewards catalog for Threadly loyalty program.

CONTEXT:
- Browsable catalog of all redeemable rewards
- Filter by category and point range
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Points balance in header
- Filter bar
- Rewards grid

HEADER:
- "Rewards" title
- Points balance: "15,450 points available"
- "Points History" link

FILTER BAR:
- Category chips: All, Discounts, Free Shipping, Products, Experiences
- Point range filter: 0-1000, 1000-5000, 5000+
- Sort: Points (Low-High), Newest, Popular

REWARDS GRID:
Each reward card:
- Reward image or icon
- Title: "10% Off Any Order"
- Description: "Apply to your next purchase"
- Points cost: "1,500 points"
- "Redeem" button (or "Not Enough Points" disabled)
- Limited indicator: "Only 50 left!" if applicable
- Tier lock: "Gold+ Only" badge if restricted

FEATURED REWARDS:
- Top section with larger cards
- "Limited Edition" or "New" badges
- Countdown for time-limited rewards

REWARD CATEGORIES:
DISCOUNTS:
- Percentage off, fixed amount off
- Minimum order requirements shown

FREE SHIPPING:
- Free standard, free express tiers

EXCLUSIVE PRODUCTS:
- Products only available via points
- Limited quantities

EXPERIENCES:
- Early access to drops
- Virtual styling session
- Brand meet & greets

REDEMPTION HISTORY:
- "Your Redeemed Rewards" section
- Active rewards with "Use by" dates
- Used rewards history
```

---

### Screen 10.3: Gamification - Daily Rewards
```
Design a premium dark-mode daily rewards screen for Threadly.

CONTEXT:
- Daily engagement feature with spin/reveal mechanic
- Streak tracking and bonus rewards
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Spin wheel or mystery box center stage
- Streak tracker
- Prize history

HEADER:
- "Daily Reward" title
- Streak counter: "🔥 7 Day Streak!"
- "Spin available" or "Come back tomorrow"

MAIN INTERACTION:
Option A - Spin Wheel:
- Animated wheel with prize segments
- Segments: 10pts, 25pts, 50pts, 100pts, Free Shipping, Mystery Prize
- "SPIN" button (large, purple)
- Spinning animation on click
- Result celebration with confetti

Option B - Mystery Box:
- Animated mystery box
- "TAP TO OPEN" button
- Opening animation
- Prize reveal with effects

STREAK TRACKER:
- 7-day progress dots
- Day 1-7 with rewards listed:
  - Day 1: 10 points
  - Day 3: 25 points
  - Day 5: 50 points
  - Day 7: Mystery Prize
- Current day highlighted
- Missed days shown dimmed

PRIZE RESULT:
- Large celebration for big prizes
- "You won: 50 Points!"
- "Points added to your balance"
- Share to social option

TODAY'S BONUS MISSIONS:
- Additional ways to earn today:
  - "Like 3 products" → +15 points
  - "Add item to wishlist" → +10 points
  - "Visit 5 stores" → +20 points
- Progress indicators

RECENT PRIZES:
- History of daily rewards won
- "Your Luck: 3 big prizes this month"

RULES:
- "How it works" expandable section
- Reset time: "Resets at midnight"
```

---

## PART 11: SUPPORT & HELP SCREENS

### Screen 11.1: Help Center
```
Design a premium dark-mode help center for Threadly.

CONTEXT:
- Self-service help and FAQ center
- Search, categories, and article browsing
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Search bar hero
- Category cards
- Popular articles

HEADER:
- "How can we help?" title
- Large search bar with icon
- "Search for answers..."
- Recent searches suggestions

CATEGORY CARDS:
- Glassmorphic cards in grid:
  - 📦 Orders & Shipping
  - 💳 Payments & Refunds
  - 🏪 Selling on Threadly
  - 👤 Account & Profile
  - 🛡️ Trust & Safety
  - 🎁 Loyalty & Rewards
- Each shows article count

POPULAR ARTICLES:
- List of most-viewed articles:
  - "How to track my order"
  - "Return policy explained"
  - "How to become a seller"
  - "Forgot password help"
- Each with view count and "helpful" rating

STILL NEED HELP:
- Glassmorphic card:
  - "Can't find what you're looking for?"
  - "Contact Support" button
  - Average response time: "Usually within 2 hours"
  - Or "Chat with us" if live chat available

FOR SELLERS:
- Separate section:
  - "Seller Help Center"
  - Quick links: Store setup, Product listing, Payments

ARTICLE PAGE (when clicked):
- Article title
- Last updated date
- Article content with formatting
- "Was this helpful?" Yes/No buttons
- Related articles suggestions
- "Contact Support" if still stuck
```

---

### Screen 11.2: Contact Support
```
Design a premium dark-mode contact support page for Threadly.

CONTEXT:
- Support ticket submission
- Issue categorization and details
- Dark aesthetic with glassmorphism

LAYOUT:
- Dark (#0f0f0f) background
- Issue type selection
- Ticket form
- Existing tickets list

HEADER:
- "Contact Support" title
- "We typically respond within 2 hours"
- Business hours note if applicable

ISSUE TYPE SELECTION:
- Large category cards:
  - "Order Issue" → Order selector appears
  - "Payment Problem" → Recent payments shown
  - "Account Help" → Security focused
  - "Report a Problem" → Abuse/safety
  - "Seller Support" → Store issues
  - "Other"

ORDER SELECTOR (if Order Issue):
- Recent orders list
- Select affected order
- Order details shown

TICKET FORM:
- Subject*: Text input
- Description*: Large textarea
  - Helper: "Please describe your issue in detail"
- Attachments: Image/file upload (up to 5)
- Priority: Normal / Urgent (explain criteria)

CONTACT PREFERENCES:
- Response preference: Email / In-app / Phone callback
- Best time to reach (if callback)

SUBMIT:
- "Submit Ticket" primary CTA
- Reference number shown on submit
- "Track in Your Tickets" link

YOUR TICKETS:
- List of open/recent tickets:
  - Ticket #, Subject
  - Status: Open, In Progress, Waiting for you, Resolved
  - Last update timestamp
  - "View" button

LIVE CHAT (if available):
- Floating button alternative
- "Chat Now" with availability indicator
```

---

## USAGE NOTES FOR UXMAGIC

1. **Each prompt is self-contained** - Can be used with a fresh UXMAGIC account
2. **Design context is repeated** - Key style guidelines included in each prompt
3. **States are specified** - Loading, empty, error states described where relevant
4. **Mobile considerations** - Most prompts mention responsive behavior
5. **Accessibility** - Focus states, contrast requirements noted

## PROMPT ORDER RECOMMENDATION

For logical build order:
1. Store Creation Flow (1.1 → 1.10)
2. Product/Collection Creation (1.6 → 1.8)
3. Store Management (2.1 → 2.6)
4. Confirmation Modals (3.1 → 3.8)
5. Customer-Facing Screens (4.1 → 4.6)
6. Private Collections (5.1 → 5.2)
7. Notifications (6.1 → 6.2)
8. Admin Moderation (7.1 → 7.7)
9. Analytics Dashboards (8.1 → 8.5)
10. Creator Program (9.1 → 9.6)
11. Loyalty & Gamification (10.1 → 10.3)
12. Support & Help (11.1 → 11.2)

---

## TOTAL SCREEN COUNT: 57 Screens

| Part | Section | Screens |
|------|---------|---------|
| 1 | Store Creation & Onboarding | 10 |
| 2 | Store Management | 6 |
| 3 | Confirmation Modals | 8 |
| 4 | Customer-Facing Store | 6 |
| 5 | Private Collections | 2 |
| 6 | Notifications | 2 |
| 7 | Admin Moderation | 7 |
| 8 | Analytics | 5 |
| 9 | Creator Dashboard | 6 |
| 10 | Loyalty & Gamification | 3 |
| 11 | Support & Help | 2 |
