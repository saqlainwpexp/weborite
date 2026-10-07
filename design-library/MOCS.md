# Moc queue — one finished reference per mockup

This is the fix for *"every niche gets the same template."* Instead of mixing fragments, the generator
now shows the model **one whole finished homepage design** (a "moc") and tells it to **clone that exact
layout**, re-skinned with the lead's brand colour, logo, photos and facts. Each generation consumes the
**next** moc in the niche's pool and retires it to the "gutter" (the used list); the next generation
pulls the next moc. When every moc in a niche has been used, the gutter resets and rotation **wraps
around** — so it never runs dry. Keep topping up a pool to add more variety.

Code: `server/pipeline/mocs.ts` (queue + niche matching), wired into `server/pipeline/generate.ts`.
It takes precedence over the recipe mixer and measured design systems; those remain the fallback for a
niche that has **no mocs yet**.

## How to add mocs

1. Take a **full-page homepage screenshot** of a design you like (the whole page top to bottom, desktop
   width). `.webp` is smallest; `.jpg`, `.png`, `.avif` also work.
2. Drop it into the matching niche's `mocs/` folder below. **Name them in order** — `1.webp`, `2.webp`,
   `3.webp`… — because the queue serves them in natural number order.
3. That's it. No rebuild, no JSON. On an installed build, the same folder under the app's **data dir**
   (`<data>/design-library/<niche>/mocs/`) overrides the shipped one, so you can add mocs to a customer
   build too.

Add as many as you like, any time — the pool never "ends."

## Niches (one `mocs/` folder each)

| Folder | Covers |
| --- | --- |
| `hvac` | HVAC, air conditioning, heating, furnaces, heat pumps |
| `plumbing` | Plumbers, drains, sewer, water heaters, leaks |
| `electrician` | Electrical contractors, wiring, panels, EV chargers |
| `roofing` | Roofers, re-roofs, gutters, shingles |
| `construction` | General contractors, remodeling, renovations, custom homes |
| `landscaping` | Lawn care, hardscaping, gardens, irrigation, tree service |
| `painting` | Interior/exterior painters, drywall, stucco |
| `cleaning` | Residential/commercial cleaning, maids, janitorial, pressure washing |
| `pest-control` | Exterminators, termites, rodents, wildlife |
| `flooring` | Flooring, carpet, tile, epoxy, hardwood, vinyl |
| `auto-repair` | Mechanics, body shops, collision, detailing, tires |
| `dental` | Dentists, orthodontics, implants |
| `medical` | Clinics, physio, chiro, optometry, vets, family practice |
| `aesthetics` | Med spas, salons, spas, beauty, barbers, lashes/brows/nails |
| `fitness` | Gyms, personal training, yoga, pilates, martial arts |
| `legal` | Law firms, attorneys, solicitors, injury/family/criminal law |
| `real-estate` | Realtors, estate agents, brokers, mortgage, property mgmt |
| `coaching` | Coaches, consultants, therapists, speakers, courses |
| `agency` | Marketing/digital/web/creative/SEO agencies |
| `restaurants` | Restaurants, cafes, bakeries, bars, food trucks, catering |
| `events` | Weddings, event planners, photographers, venues, florists |
| `interior-design` | Interior designers, decorators, furniture, cabinetry |
| `saas-tech` | Software, SaaS, apps, startups, platforms |
| `ecommerce` | Online stores, DTC product brands, retail |
| `general` | **Catch-all** — used for any business that doesn't match a niche above |

A business is matched to a niche by keywords in its vertical text. If the matched niche has no mocs yet,
the queue falls back to the `general` pool; if that's empty too, it falls back to the old recipe/design
system. So `general` is a good place to keep broadly reusable designs.
