import { openLinkInBrowser } from "../../lib/utils/bolt";
import { version } from "../../../shared/shared";
import banner from "../assets/banner_icon.png?inline";

const Link = ({ href, children }: { href: string; children: string }) => (
  <a
    href="#"
    onClick={(e) => {
      e.preventDefault();
      openLinkInBrowser(href);
    }}
  >
    {children}
  </a>
);

export const About = () => (
  <div className="nm-about">
    <h2>
      <img className="nm-logo-img" src={banner} alt="NekoMitai" />
    </h2>
    <p className="nm-about-tag">
      Browse the web and watch reference videos without leaving After Effects.
    </p>
    <p>Version {version}</p>
    <p>
      Made by <strong>Akamine Izuna</strong> ·{" "}
      <Link href="https://x.com/Izuna_text">X @Izuna_text</Link>
    </p>
    <p>
      Support us! ☕{" "}
      <Link href="https://buymeacoffee.com/izunatext">
        buymeacoffee.com/izunatext
      </Link>
    </p>
    <p>
      <Link href="https://github.com/hignode/nekomitai">
        github.com/hignode/nekomitai
      </Link>
    </p>
    <p className="nm-about-notices">
      MIT licensed. Built with Bolt CEP (MIT). Bundles @ghostery/adblocker
      (MPL-2.0); the optional blocker fetches EasyList/EasyPrivacy (CC BY-SA
      3.0, © The EasyList authors). Full notices: THIRD-PARTY-NOTICES.md in
      the repo.
    </p>
  </div>
);
