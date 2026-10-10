import { useEffect, useState, type ReactNode } from "react";
import { useNow } from "../lib/hooks";
import { Link, useLocation } from "../lib/router";
import { MarketClock } from "./bits";

const NAV = [
  { to: "/", label: "Tonight" },
  { to: "/start", label: "Start here" },
  { to: "/record", label: "Record" },
  { to: "/data", label: "Data" },
  { to: "/replay", label: "Replay" },
  { to: "/proof", label: "Proof" }
];

function Wordmark() {
  return (
    <Link to="/" className="wordmark" aria-label="Redeye, home">
      <span className="wordmark__eye" aria-hidden="true" />
      redeye
    </Link>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem("redeye-theme");
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) window.localStorage.setItem("redeye-theme", theme);
      else window.localStorage.removeItem("redeye-theme");
    } catch {
      // Storage can be blocked; the choice then lasts for this visit only.
    }
  }, [theme]);
  const dark =
    theme === "dark" ||
    (theme === null && !window.matchMedia("(prefers-color-scheme: light)").matches);
  return (
    <button
      className="iconbutton"
      type="button"
      onClick={() => setTheme(dark ? "light" : "dark")}
      aria-label={dark ? "Switch to the light page" : "Switch to the night page"}
      title={dark ? "Light page" : "Night page"}
    >
      {dark ? (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <circle cx="10" cy="10" r="3.6" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path
            d="M10 2.5v2M10 15.5v2M2.5 10h2M15.5 10h2M4.7 4.7l1.4 1.4M13.9 13.9l1.4 1.4M4.7 15.3l1.4-1.4M13.9 6.1l1.4-1.4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" aria-hidden="true">
          <path
            d="M15.5 12.6A6.3 6.3 0 0 1 7.4 4.5a6.3 6.3 0 1 0 8.1 8.1z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const { path } = useLocation();
  const now = useNow(1000);
  const [menu, setMenu] = useState(false);
  useEffect(() => setMenu(false), [path]);
  return (
    <>
      <a className="skip" href="#main">
        Skip to the page
      </a>
      <header className="topbar">
        <div className="topbar__inner">
          <Wordmark />
          <nav className={`nav${menu ? " nav--open" : ""}`} aria-label="Main">
            {NAV.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                className={`nav__link${(item.to === "/" ? path === "/" : path.startsWith(item.to)) ? " nav__link--active" : ""}`}
                aria-current={path === item.to ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="topbar__right">
            <MarketClock now={now} />
            <ThemeToggle />
            <button
              className="iconbutton nav-toggle"
              type="button"
              aria-expanded={menu}
              aria-label="Menu"
              onClick={() => setMenu((m) => !m)}
            >
              <svg viewBox="0 0 20 20" aria-hidden="true">
                <path
                  d={menu ? "M5 5l10 10M15 5L5 15" : "M3 7h14M3 13h14"}
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="footer">
        <div className="wrap footer__inner">
          <div>
            <Wordmark />
            <p className="footer__line">The agent for when Wall Street is closed.</p>
          </div>
          <div className="footer__cols">
            <div>
              <h2>Look around</h2>
              <Link to="/start">Start here</Link>
              <Link to="/record">The record</Link>
              <Link to="/data">Research data</Link>
              <Link to="/replay">Replay</Link>
              <Link to="/proof">Proof and contracts</Link>
            </div>
            <div>
              <h2>For developers</h2>
              <Link to="/proof#developers">Connect an agent</Link>
              <a href="https://github.com/Jennycruzy/redeye" target="_blank" rel="noreferrer">
                Source code
              </a>
            </div>
          </div>
        </div>
        <p className="wrap footer__legal">
          Not investment advice. Tokenized stocks can lose value. Prices come from public sources
          and are shown with their source and age.
        </p>
      </footer>
    </>
  );
}
