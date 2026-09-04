"""The BRIDGE `scotese_02` run sequence (Foster et al. 2017 CO2 reconstruction)
-- the HadCM3 timeslices behind Valdes, Scotese & Lunt 2021, "Deep ocean
temperatures through time" (Clim. Past, 17, 1483-1506,
https://doi.org/10.5194/cp-17-1483-2021).

Scraped directly from the BRIDGE group's own index page (confirmed to match
the paper's stated simulation count exactly):
https://www.paleo.bristol.ac.uk/ummodel/scripts/html_bridge/scotese_02.html

Run codes are BRIDGE's own randomly-assigned, case-sensitive 5-6 character
simulation identifiers (see Using_BRIDGE_webpages.pdf) -- e.g. "texPw2" and
"texpw2" are two different runs, not a typo. 109 entries, oldest (541 Ma)
first, monotonically decreasing to present (0 Ma) -- verified via
`sort -rn -c` against the scraped page, no duplicate run codes.
"""

RUNS: list[tuple[str, float]] = [
    ("texqe", 541), ("texqd", 535), ("texqc", 530), ("texqb", 525), ("texqa", 520),
    ("teXPz", 515), ("teXPy", 510), ("teXPx", 505), ("teXPw", 499), ("teXPv", 496),
    ("teXPu", 492), ("teXPt", 485), ("teXPs", 482), ("teXPr", 475), ("teXPq", 470),
    ("teXPp", 465), ("teXPo", 460), ("teXPn", 456), ("teXPm", 449), ("teXPl", 445),
    ("teXPk", 441), ("teXPj", 436), ("teXPi", 430), ("teXPh", 425), ("teXPg", 421),
    ("teXPf", 415), ("teXPe", 409), ("teXPd", 405), ("teXPc", 400), ("teXPb", 395),
    ("teXPa", 391), ("teXpz", 385), ("teXpy", 380), ("teXpx", 375), ("teXpw", 370),
    ("teXpv", 366), ("teXpu", 359), ("teXpt", 354), ("teXps", 349), ("teXpr", 344),
    ("teXpq", 339), ("teXpp", 333), ("teXpo", 331), ("teXpn", 327), ("teXpm", 319),
    ("teXpl", 315), ("teXpk", 311), ("teXpj", 305), ("teXpi", 301), ("teXph", 297),
    ("teXpg", 293), ("teXpf", 287), ("teXpe", 280), ("teXpd", 275), ("teXpc", 269),
    ("teXpb", 265), ("teXpa", 263), ("texPz", 256), ("texPy", 252), ("texPx", 245),
    ("texPw2", 240), ("texPv1", 234), ("texPu1", 232), ("texPt1", 227), ("texPs1", 222),
    ("texPr1", 218), ("texPq1", 213), ("texPp1", 205), ("texPo1", 201), ("texPn1", 196),
    ("texPm1", 191), ("texPl1", 187), ("texPk1", 178), ("texPj1", 172), ("texPi1", 168),
    ("texPh2", 165), ("texPg1", 160), ("texPf1", 155), ("texPe2", 149), ("texPd2", 145),
    ("texPc2", 142), ("texPb2", 136), ("texPa2", 131), ("texpz1", 127), ("texpy1", 122),
    ("texpx2", 116), ("texpw2", 111), ("texpv1", 107), ("texpu1", 103), ("texpt2", 97),
    ("texps2", 92), ("texpr2", 87), ("texpq", 81), ("texpp", 75), ("texpo1", 69),
    ("texpn1", 66), ("texpm1", 61), ("texpl1", 56), ("texpk2", 52), ("texpj2", 45),
    ("texpi1", 40), ("texph1", 36), ("texpg1", 31), ("texpf", 26), ("texpe", 20),
    ("texpd", 15), ("texpc", 11), ("texpb", 3), ("texpa1", 0),
]

assert len(RUNS) == 109, f"expected 109 BRIDGE runs, got {len(RUNS)}"
assert len({r for r, _ in RUNS}) == 109, "duplicate run code in RUNS"
_ages = [a for _, a in RUNS]
assert _ages == sorted(_ages, reverse=True), "RUNS must be oldest-first, monotonically decreasing"


def cache_dirname(index: int, run: str) -> str:
    """Collision-safe cache subdirectory name for RUNS[index].

    Run codes are only unique case-SENSITIVELY (see module docstring --
    e.g. teXPb/teXpb/texpb are three different runs, 35 such collision
    groups covering 80 of the 109 codes). macOS's default filesystem (APFS)
    is case-insensitive, so a bare run code is not a safe directory name:
    teXPb/, teXpb/, and texpb/ all resolve to the SAME physical directory
    there. fetch_bridge.py's exists()-based skip logic then silently treated
    the 2nd/3rd run's downloads as "already cached" when they were actually
    the 1st run's files under a folded name -- confirmed to have corrupted
    45 of 109 runs before this fix (each mislabeled with an older run's
    data). Prefixing with the RUNS index guarantees uniqueness regardless of
    case folding; both fetch_bridge.py and prep_bridge.py must use this same
    function so they agree on where a run's files live.
    """
    return f"{index:03d}_{run}"
