# Design System Document: The Scholastic Atelier

## 1. Overview & Creative North Star: "The Digital Curator"
This design system moves away from the rigid, "boxed-in" feel of traditional educational software. Our Creative North Star is **The Digital Curator**. We treat data not as a static list, but as an editorial exhibition. The goal is to convey institutional authority and "Trustworthy Professionalism" through sophisticated whitespace, tonal depth, and high-end typography rather than heavy borders or generic shadows.

By leveraging **Intentional Asymmetry**—such as offsetting header content or using varying column widths—we break the "template" look. We favor breathing room over density, ensuring that educators feel a sense of calm and organization rather than data fatigue.

---

## 2. Colors & Surface Philosophy
The palette is rooted in a "Atmospheric Blue" spectrum. It uses high-chroma accents only for critical status indicators (Attendance), keeping the rest of the interface serene and focused.

### The "No-Line" Rule
**Standard 1px borders are strictly prohibited for sectioning.** To define boundaries, use background shifts:
- A `surface-container-low` card sitting on a `surface` background.
- A `surface-container-highest` sidebar against a `surface-bright` main canvas.

### Surface Hierarchy & Nesting
Treat the UI as a series of layered fine-paper sheets. Use the `surface-container` tiers to create depth:
1.  **Base Layer:** `surface` (#f7f9ff) - The primary canvas.
2.  **Secondary Content:** `surface-container-low` (#f1f4fa) - For grouping related data.
3.  **Active/Elevated Elements:** `surface-container-lowest` (#ffffff) - For the most critical interactive cards.

### The "Glass & Gradient" Rule
To add "soul" to the dashboard:
- **Hero CTAs:** Use a subtle linear gradient from `primary` (#005bbf) to `primary_container` (#1a73e8) at a 135-degree angle.
- **Floating Modals/Popovers:** Apply **Glassmorphism**. Use `surface` at 80% opacity with a `20px` backdrop-blur to allow the content underneath to bleed through softly.

---

## 3. Typography: Editorial Authority
We pair the geometric precision of **Manrope** for display logic with the functional clarity of **Inter** for data.

- **Display & Headlines (Manrope):** Use `display-lg` and `headline-md` for page titles and high-level stats. This introduces a "premium publication" feel that builds trust.
- **Body & Labels (Inter):** Use `body-md` for general data and `label-sm` for table headers.
- **The Contrast Play:** Set your `headline-lg` in `on_surface` (#181c20) but your supporting `body-sm` in `on_surface_variant` (#414754). This contrast ensures the hierarchy is felt before it is read.

---

## 4. Elevation & Depth
We achieve hierarchy through **Tonal Layering** and physics-based lighting, never "drop shadows" in the traditional sense.

- **The Layering Principle:** To lift a "Present" student card, place a `surface-container-lowest` card on a `surface-container-high` background.
- **Ambient Shadows:** For floating elements (like a Google Sheets link picker), use an extra-diffused shadow: `0px 20px 40px rgba(24, 28, 32, 0.06)`. Note the use of `on_surface` for the shadow tint to keep it natural.
- **The "Ghost Border" Fallback:** If a divider is mandatory for accessibility in a dense table, use `outline_variant` at **15% opacity**. It should be a suggestion of a line, not a barrier.

---

## 5. Components

### Data Tables (The "Open Grid")
Forbid the use of vertical or horizontal divider lines. 
- **Separation:** Use `spacing-4` (0.9rem) of vertical padding between rows.
- **Hover State:** On hover, transition the row background to `surface-container-low`.
- **Status Badges:** For Attendance, use `tertiary_container` (#008939) with `on_tertiary_fixed` text for "Present," and `error_container` (#ffdad6) with `on_error_container` for "Absent." Use a `full` (9999px) roundedness for these chips.

### Input Fields (Google Sheets Integration)
- **Style:** Use a `surface-container-low` fill with a `md` (0.375rem) corner radius.
- **Interaction:** On focus, transition the background to `surface-container-lowest` and apply a `2px` `primary` "Ghost Border" at 40% opacity. 
- **Instructional Text:** Use `label-md` in `on_surface_variant` to explain the link requirements.

### Buttons
- **Primary:** Gradient fill (Primary to Primary-Container), `xl` (0.75rem) roundedness, `on_primary` text.
- **Secondary:** `surface-container-high` background with `primary` text. No border.
- **Tertiary (Ghost):** No background. Use `primary` text and a subtle `0.5rem` padding for a soft touch target.

### Cards & Progress
- **The "Signature" Card:** Use `xl` (0.75rem) roundedness. Avoid shadows; use a subtle background shift from the container it sits on.
- **Attendance Progress Bar:** A thick `6px` track using `surface-container-highest` with a `tertiary` (#006d2c) fill.

---

## 6. Do's and Don'ts

### Do:
- **Do** use `spacing-12` and `spacing-16` for major section margins to create an "Editorial" feel.
- **Do** use `surface-bright` for the main background to keep the interface feeling "airy."
- **Do** align numerical data to the right in tables for professional readability.
- **Do** use `tertiary` (green) and `error` (red) only for status; never for decorative elements.

### Don't:
- **Don't** use 100% black text. Always use `on_surface` (#181c20).
- **Don't** use standard "Box Shadows." If it needs to float, it needs a Tinted Ambient Shadow.
- **Don't** use sharp corners. Our softest radius is `0.25rem` (`DEFAULT`), but our standard for cards is `0.75rem` (`xl`).
- **Don't** use "Zebra Striping" for tables. Use whitespace and subtle hover-states instead.