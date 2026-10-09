import { Link } from "../lib/router";

export default function NotFound() {
  return (
    <div className="wrap page closing">
      <p className="eyebrow">404</p>
      <h1 className="display display--sm">
        Nothing here, <em>not even overnight</em>.
      </h1>
      <Link to="/" className="button button--primary">
        Back to tonight
      </Link>
    </div>
  );
}
