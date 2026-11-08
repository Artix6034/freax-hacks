# Freedom Broker frontend

The frontend now opens a landing page and then the dialogue review service. The sidebar is replaced by a compact header. The workbench contains import, checklist and evaluation controls, followed by matched transcript/result panels. History shows real saved assessments as an expandable timeline. Original scores, human revisions and unresolved totals remain distinct.

The interface combines HTML, CSS, JavaScript and locally bundled React widgets. Animations respect reduced motion and pause off screen. Native select values and change events remain connected to the controller; visible menus support keyboard navigation. The palette contains white, black and Freedom green with transparency. Primary buttons use white text on shaded green with approximately 4.90:1 contrast.

The original Freedom Broker logo is sourced from https://www-aix-kz.s3.eu-central-1.amazonaws.com/uploads/2022/12/Logo-1.png. The favicon uses the original fbroker.kz icon. The existing Manrope font and OFL license are reused.

The production startup, API routes, model adapters, official export pipeline and Dynamics 365 origin restrictions remain in place. The browser still checks submission compatibility before paid evaluations and requires an explicit choice for an incompatible checklist. The Dynamics bridge imports a dialogue only after its allowed parent completes the handshake; importing never starts an AI evaluation. Only the evaluation summary is sent back to the parent.

All frontend resources are served through the explicit server asset map. Unknown HTML routes return the custom 404 page; unknown API routes and private file paths remain JSON errors. No runtime keys, local datasets, references or new assessment results are part of this update.

Validation: run `npm test` with Node 24. Tests cover backend and production startup, Dynamics isolation, official export compatibility, frontend selection races, original/final score rendering, unknown totals, navigation and the complete asset graph. Visual browser QA is unavailable in the current managed environment because the required browser tool is absent.
