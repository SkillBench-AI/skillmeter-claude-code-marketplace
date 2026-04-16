---
name: skillbench-brand
description: Comprehensive brand guidelines for SkillBench, including visual identity, color palette, typography, logo usage, and PowerPoint templates. This skill should be used when creating presentations, UI mockups, visual designs, or any branded content for SkillBench.
---

# SkillBench Brand Guidelines

This skill provides comprehensive brand guidelines for SkillBench, enabling consistent visual identity across all presentations, designs, and branded materials.

## Brand Overview

SkillBench's brand identity centers on "The operating system for the AI transition" with a modern, tech-forward aesthetic. The visual system uses geometric shapes (circles and half-circles) as core brand elements, paired with a vibrant color palette of Mint and Cyan as primary colors against Charcoal and neutral tones.

## When to Use This Skill

Trigger this skill for any of the following requests:
- Creating PowerPoint presentations
- Designing UI mockups or digital interfaces
- Producing branded visual content
- Applying SkillBench's visual identity to documents
- Working with company logos or brand elements
- Ensuring brand consistency across materials

## Color Palette

Use these exact color values for all SkillBench branded materials:

### Primary Colors

**Mint** (Primary brand color)
- Hex: `#55B184`
- RGB: `85, 177, 132`
- CMYK: `76, 1, 67, 0`

**Cyan** (Secondary brand color)
- Hex: `#43BBEA`
- RGB: `67, 187, 234`
- CMYK: `73, 0, 1, 0`

### Supporting Colors

**Charcoal** (Text and dark backgrounds)
- Hex: `#3A3F51`
- RGB: `58, 63, 81`
- CMYK: `79, 70, 46, 37`

**Faint Gray** (Light backgrounds, subtle elements)
- Hex: `#F0ECEC`
- RGB: `240, 236, 236`
- CMYK: `4, 6, 4, 0`

**Melon** (Accent color)
- Hex: `#EEB6B3`
- RGB: `238, 182, 179`
- CMYK: `0, 36, 20, 0`

**Black**
- Hex: `#000000`
- RGB: `16, 0, 0`
- CMYK: `0, 0, 0, 100`

### Color Usage Guidelines

- Use Mint and Cyan as primary accent colors for visual interest and brand recognition
- Apply Charcoal for body text and dark UI elements
- Use Faint Gray for backgrounds and subtle separations
- Use Melon sparingly as a tertiary accent
- Prefer gradients between Mint and Cyan for backgrounds (see reference images)

## Typography

**Primary Typeface: Figtree**

- **Headings:** Figtree Extra Bold
- **Body Text:** Figtree Regular
- **All Text:** Lowercase preferred for brand wordmark; standard case for body copy

### Font Files

The complete Figtree font family is included in `assets/fonts/`:

**Primary Brand Fonts:**
- `Figtree-ExtraBold.ttf` - For headlines, titles, and emphasis
- `Figtree-Regular.ttf` - For body text and general content

**Complete Font Family Available:**
- Variable fonts: `Figtree-VariableFont_wght.ttf`, `Figtree-Italic-VariableFont_wght.ttf`
- Static fonts: Light, Regular, Medium, SemiBold, Bold, ExtraBold, Black (plus italic variants)
- License: `OFL.txt` (SIL Open Font License - free for commercial use)

### Using Fonts in PowerPoint

When creating PowerPoint presentations, the pptx skill can embed fonts directly:

1. Read the font file from `assets/fonts/` (e.g., `Figtree-ExtraBold.ttf`)
2. Use the pptx skill's font embedding capabilities to include the font in the presentation
3. This ensures presentations display correctly even on systems without Figtree installed

Alternatively, for web-based or Google Slides presentations, reference Figtree from Google Fonts: https://fonts.google.com/specimen/Figtree

### Typography Best Practices

- Use Figtree Extra Bold for headlines and emphasis
- Use Figtree Regular for body text and supporting content
- Maintain clean, modern typographic hierarchy
- Ensure sufficient contrast between text and backgrounds
- When possible, embed fonts in documents to ensure consistent display across platforms

## Logo Usage

Logo assets are located in `assets/logos/`. Use the appropriate logo variant based on background and context:

### Logo Variants

**Black Logo** (`logo-SkillBench-black.png`)
- Use on white or very light backgrounds
- Use in print materials with light backgrounds
- Available in: PNG, AI, EPS

**White Logo** (`logo-SkillBench-white.png`)
- Use on dark backgrounds or photography
- Use on Mint/Cyan gradient backgrounds
- For presentations: use `logo-SkillBench-white-pptbackground.png`
- Available in: PNG, AI, EPS

**Color Logo** (`logo-SkillBench-color.png`)
- Features Mint and Cyan circles with Charcoal text
- Use on white or Faint Gray backgrounds
- Primary logo for most applications
- For presentations: use `logo-SkillBench-color-pptbackground.png`
- Available in: PNG, AI, EPS

**Icon/Mark Only** (`logo-SkillBench-color-no-text.png`)
- Four-circle geometric mark without text
- Use for app icons, favicons, or small spaces
- Available in: PNG

### Logo Selection Guide

To select the appropriate logo:
1. Identify the background color
2. Choose the logo with sufficient contrast:
   - Light backgrounds → Black or Color logo
   - Dark backgrounds → White logo
   - Gradient backgrounds → White logo
   - Presentation slides → Use *-pptbackground.png variants
3. Ensure logo has adequate clear space around it
4. Never distort, rotate, or apply effects to the logo

## Brand Elements

The geometric brand element is located in `assets/graphics/Brand-Element-SkillBench.png` (also available as EPS).

This pattern of circles and half-circles can be used as:
- Decorative background elements
- Section dividers
- Visual texture on slides
- Reinforcement of brand identity

Apply the brand element subtly—it should enhance rather than overwhelm the content.

## PowerPoint Template

### Using the Template

The PowerPoint template is located at `assets/templates/SkillBench-PPT-v2.pptx`.

To create presentations:
1. Read the template file using the pptx skill
2. Analyze the existing slide layouts, master slides, and formatting
3. Apply the template's design system to new presentations
4. Maintain consistency with color palette, typography, and logo placement
5. Use the slide masters as reference for proper formatting

### Presentation Best Practices

- Start with title slides featuring the gradient background (Mint to Cyan)
- Use ample white space for clean, modern aesthetic
- Place logos consistently (typically top-left or bottom-right)
- Use Charcoal text on light backgrounds for optimal readability
- Apply brand elements sparingly as visual accents
- Maintain consistent heading hierarchy throughout

## Creating PowerPoint Presentations

When creating presentations from scratch:

1. **Read the pptx skill documentation** to understand PowerPoint creation best practices
2. **Load the template** from `assets/templates/SkillBench-PPT-v2.pptx` to understand the existing design system
3. **Embed Figtree fonts** from `assets/fonts/`:
   - Load `Figtree-ExtraBold.ttf` for headings
   - Load `Figtree-Regular.ttf` for body text
   - Use the pptx skill's font embedding capabilities to ensure fonts display correctly
4. **Apply brand colors** using the exact hex values provided above
5. **Insert appropriate logo** from `assets/logos/` based on slide backgrounds
6. **Reference the style guide PDF** at `references/SkillBench-Style-Guide.pdf` for visual examples
7. **Maintain consistency** across all slides

## Creating UI Mockups

When designing user interfaces or digital products:

1. Use the brand color palette with Mint and Cyan as primary accent colors
2. Apply Charcoal for text and UI elements
3. Use Faint Gray for backgrounds and subtle containers
4. Incorporate the geometric brand elements as subtle visual details
5. Ensure typography follows Figtree usage guidelines
6. Maintain clean, modern design aesthetic consistent with brand identity
7. Use appropriate logo variant based on interface theme (light/dark)

## Reference Materials

Complete visual reference is available at `references/SkillBench-Style-Guide.pdf`. This PDF contains:
- Visual examples of logo usage
- Color palette swatches
- Typography samples
- Brand element applications
- Real-world branded material examples

Consult this reference when uncertain about brand application or when seeking visual inspiration.

## Quality Assurance

Before finalizing any branded material, verify:
- [ ] Color values match the exact hex codes specified
- [ ] Figtree font is used correctly (Extra Bold for headings, Regular for body)
- [ ] Appropriate logo variant is used with proper contrast
- [ ] Brand elements enhance rather than overwhelm content
- [ ] Overall aesthetic aligns with modern, tech-forward brand identity
- [ ] Sufficient white space maintains clean, professional appearance
- [ ] Typography hierarchy is clear and consistent
