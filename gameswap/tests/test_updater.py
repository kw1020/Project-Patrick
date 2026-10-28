"""GameSwap updating itself from GitHub Releases."""

import hashlib
import json

import pytest

from gameswap import updater

SETUP = b"MZ pretend installer"
SHA = hashlib.sha256(SETUP).hexdigest()


def release(version, sha_digest=True, sha_file=False, draft=False, tag_prefix="gameswap-v"):
    name = f"GameSwap-Setup-{version}.exe"
    assets = [{"name": name, "size": len(SETUP), "browser_download_url": f"https://dl/{name}",
               **({"digest": f"sha256:{SHA}"} if sha_digest else {})}]
    if sha_file:
        assets.append({"name": name + ".sha256", "browser_download_url": f"https://dl/{name}.sha256"})
    return {"tag_name": f"{tag_prefix}{version}", "draft": draft, "prerelease": False, "assets": assets,
            "html_url": f"https://github.com/r/{version}"}


def test_newest_newer_release_is_picked():
    rels = [release("0.8.1"), release("0.8.10"), release("0.8.2"), release("1.0.0", draft=True),
            release("9.9.9", tag_prefix="other-v")]
    u = updater.pick_update(rels, "0.8.1")
    assert u.version == "0.8.10" and u.sha256 == SHA and u.name == "GameSwap-Setup-0.8.10.exe"
    assert updater.pick_update(rels, "0.8.10") is None, "already up to date"


def test_release_without_a_checksum_is_never_offered():
    assert updater.pick_update([release("0.9.0", sha_digest=False)], "0.8.1") is None
    assert updater.pick_update([release("0.9.0", sha_digest=False, sha_file=True)], "0.8.1").sha_url


def test_no_internet_means_no_update():
    def offline(url):
        raise OSError("no network")
    assert updater.check("0.8.1", fetch=offline) is None


def test_download_is_checked_before_it_is_used(tmp_path):
    files = {"https://dl/GameSwap-Setup-0.9.0.exe": SETUP,
             "https://dl/GameSwap-Setup-0.9.0.exe.sha256": f"{SHA}  GameSwap-Setup-0.9.0.exe".encode()}
    u = updater.check("0.8.1", fetch=lambda url: json.dumps([release("0.9.0", sha_digest=False, sha_file=True)])
                      .encode() if "api.github" in url else files[url])
    path = updater.download(u, tmp_path, fetch=files.__getitem__)
    assert path.read_bytes() == SETUP

    files["https://dl/GameSwap-Setup-0.9.0.exe"] = b"MZ tampered!!!!!!!!!"  # same size, different bytes
    with pytest.raises(ValueError, match="checksum"):
        updater.download(u, tmp_path / "x", fetch=files.__getitem__)


def test_installer_runs_silently_and_restarts_gameswap(tmp_path):
    cmd = updater.install_command(tmp_path / "GameSwap-Setup-0.9.0.exe")
    assert "/VERYSILENT" in cmd and "/relaunch=1" in cmd


def test_installer_script_restarts_gameswap_after_an_update():
    from pathlib import Path
    iss = (Path(__file__).parent.parent / "installer" / "GameSwap.iss").read_text(encoding="utf-8")
    assert "Check: RelaunchAfterUpdate" in iss and "{param:relaunch|0}" in iss


def test_versions_compare_as_numbers():
    assert updater.version_tuple("0.8.10") > updater.version_tuple("0.8.9")
    assert updater.version_tuple("1.0") > updater.version_tuple("0.99.99")
