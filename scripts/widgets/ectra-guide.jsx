// scripts/widgets/ectra-guide.jsx

// The tuning book: what to do at each stage of bringing up a PMSM drive, and in what order.
// Prose only, because every knob it could offer is a knob the grid already has:
// one control in two places is one control too many.
//
// What it does instead is aim the rest of the app.
// Picking a stage highlights the registers that stage tunes,
// charts what has to be watched while tuning them,
// and drops the groups that take no part in it out of the poll cycle.
// That is the part modra cannot do on its own:
// it holds no opinion about any device, and this file is nothing but an opinion about one.
// Above the prose, a few sentences say what holds the drive back right now,
// read off the registers they name.
//
// The tables are `EctraTables`.
// A table is a shape the grid cannot draw, so it earns its own panel;
// this one earns a column beside the grid,
// because its text and the rows it points at have to be readable together.

const EC_STAGE_KEY = "modra.ectra.stage";

// Groups no page of this book ever tunes:
// a log, counters, the identity of the board, the serial port, the flow table.
// Still readable and writable, they simply stop costing a slot in every cycle,
// so what IS being tuned comes back faster.
//
// `Flow` and `Journal` alone are 367 of 644 registers,
// and no other group passes twenty-four.
// That is the whole argument for where this list ends:
// past these, muting buys almost nothing and risks hiding a reading that turns out to matter.
// Filter calibration (`MeasCfg`, `Trim`) stays in view for exactly that reason:
// a wrong current scale is the first stage's problem and it would be invisible from here.
const EC_DEAD = [
  "Flow:*", "Journal:*", "Counter:*", "Version:*", "System:*",
  "RS485:*", "Digital:*", "AnalogInput:*", "Failsafe:*",
];

// Skip bands shape a voltage table and nothing else, so only the V/f page keeps them.
// Every page carries its own list, built from the shared floor.
const EC_MUTE_VF = EC_DEAD;
const EC_MUTE = EC_DEAD.concat("Resonance:*");

// A register name in prose: what `ecNamed` collects and `Para` turns into a link
const EC_NAME = "[A-Z][A-Za-z]*:[A-Za-z0-9]+";

// Every register a page names in its own prose.
// The page talks about it, so the page has to keep it arriving:
// an instruction pointing at a row frozen at its last value is worse than no instruction.
// Derived from the text rather than listed beside it,
// because a list beside it is a list that goes stale.
const ecNamed = (text) => text.match(new RegExp(EC_NAME, "g")) || [];

// Lit in the grid at every stage.
// How the drive is commanded, what it made of that, and how a fault is cleared
// belong to no single step: they are how you start, stop and recover at each of them,
// and a stage that hid them would be a stage you cannot leave.
//
// `Drive:Stage` earns its place twice over.
// `Drive:Mode` is what you asked for and `Drive:Stage` is what the drive did with it,
// and the two disagree exactly when something is wrong:
// missing motor constants drop a vector run to `obs`, a bad current channel to `guard`.
// Reading the request without the answer
// is how an hour goes into tuning a mode that never engaged.
const EC_FIND_ALWAYS =
  "Ctrl:Mode|Ctrl:Setpoint|Drive:Mode|Drive:Stage|Fault:Code|Fault:Clear";

// Charted at every stage: what the drive was asked for, what it rendered,
// what came back from the meters, and the two readings that end a run badly.
const EC_ALWAYS = [
  "Feedback:SetpointFreq", "Feedback:RenderFreq", "MeasCtrl:Freq",
  "MeasCtrl:CurrAvg", "MeasCtrl:PeakMax", "MeasCtrl:Temp",
  // Charted as well as lit, because the counters beside it say
  // how many takeovers and losses there were and never when.
  // A stepped trace of the stage is the only place a drop out of `closed` has a time on it.
  "Drive:Stage",
];

// Panels are small unless a reading earns otherwise.
// The operating point always does:
// it is the one trace that says whether the drive is doing what was asked.
// Each stage adds the single reading it is tuning against.
const EC_BIG = ["Feedback:RenderFreq"];

//---------------------------------------------------------------------------------------- Verdicts

// What each `Sync:ExitCause` means, worded to follow "przyczynę: <cause>, gdy".
// The takeover page lists them and the live note names the one standing.
const EC_EXIT = {
  slip: "estymata prędkości przekroczyła częstotliwość rampy o więcej niż Foc:SlipMax "
    + "albo spadła poniżej jej połowy",
  unlock: "obserwator utracił synchronizację kąta",
  weak: "zapadł się strumień",
  config: "konfiguracja unieważniła obserwator",
};

// Every `Fault:Code`, what tripped it and the first thing to check.
// The faults page reads them in this order, and the live note quotes the one that is active.
const EC_FAULTS = [
  {
    codes: ["peak"],
    text:
      "Licznik komparatora prądu Fault:PeakEvents osiągnął Thresh:PeakCount. "
      + "Za wysokie wartości tabeli albo za duże obciążenie.",
  },
  {
    codes: ["imax"],
    text:
      "Amplituda prądu fazy (połowa MeasCtrl:PeakMax) ponad Thresh:CurrPeak. "
      + "Sprawdź tabelę i obciążenie.",
  },
  {
    codes: ["irms"],
    text:
      "MeasCtrl:CurrAvg ponad Thresh:CurrRms. Sprawdź tabelę, obciążenie i Speed:DerateCurr.",
  },
  {
    codes: ["stall"],
    text:
      "Wirnik nie ruszył na tabeli V/f. Sprawdź Drive:AlignTime i Volt:2Hz.",
  },
  {
    codes: ["temp"],
    text:
      "Temperatura stopnia mocy ponad Thresh:Temp. Sprawdź chłodzenie.",
  },
  {
    codes: ["hv-"],
    text:
      "Napięcie szyny DC poniżej Thresh:DcBusMin. Sprawdź zasilanie.",
  },
  {
    codes: ["hv+"],
    text:
      "Napięcie szyny DC ponad Thresh:DcBusMax, a przy zwrocie energii już 30V niżej: "
      + "za szybkie zwalnianie, utrata synchronizmu albo rozruch przy wirującym wentylatorze.",
  },
  {
    codes: ["lv-", "lv+"],
    text:
      "Napięcie zasilacza pomocniczego (Meas:Flyback) poza zakresem od Thresh:FlybackMin "
      + "do Thresh:FlybackMax.",
  },
  {
    codes: ["sync"],
    text:
      "Utrata synchronizacji w pętli zamkniętej, brak przejęcia w czasie Foc:EntryTimeout "
      + "albo faza bez prądu. Sync:ExitCause (etap 5) opisuje tylko utratę synchronizacji.",
  },
  {
    codes: ["spin"],
    text:
      "Wirnik nie nadąża za wymuszonym polem (etap 3). Sprawdź, czy wał kręci się swobodnie "
      + "i we właściwą stronę (Motor:Invert).",
  },
  {
    codes: ["feed"],
    text:
      "Tylko wpis w dzienniku: przy starcie napęd odrzucił pomiar prądu "
      + "i pracuje w V/f (etap 1).",
  },
  {
    codes: ["link"],
    text:
      "Utrata komunikacji wewnętrznej napędu. "
      + "Gdy się powtarza (Counter:Link), wskazuje na problem sprzętowy.",
  },
];

// `Drive:Stage` values that say why the table drives the bridge in `if` or `foc`.
// `off` is missing: it answers `Drive:Mode = vf`, which is no news.
const EC_WHY = {
  shunt: "Drive:Stage = shunt: tor pomiaru prądu nie ma skali (Sense:ShuntRes, Sense:ShuntGain), "
    + "więc mostek prowadzi tabela V/f.",
  obs: "Drive:Stage = obs: brakuje danych silnika (Motor:Rs, Motor:Lq, w trybie foc także "
    + "Motor:Ke), więc mostek prowadzi tabela V/f.",
  volts: "Drive:Stage = volts: brakuje zapasu napięcia pod Foc:ModCeil, więc mostek "
    + "prowadzi tabela V/f.",
  guard: "Drive:Stage = guard: przy starcie napęd odrzucił tor prądu i pracuje według tabeli "
    + "V/f. Porównaj Foc:GuardId z Foc:GuardIdRef.",
};

const EC_FREEZE = {
  "hv-": "Rampa nie przyspiesza: napięcie szyny DC jest poniżej Freeze:VdcLow.",
  "hv+": "Rampa nie zwalnia: napięcie szyny DC jest powyżej Freeze:VdcHigh.",
};

// `Sync:Lock` at which the takeover arms
const EC_LOCK_FULL = 40;
// How close to `Foc:EntryFreq` the ramp counts as standing on it
const EC_ENTRY_TOL_Hz = 0.1;

// Everything the live note reads, kept arriving while a stage mutes the rest
const EC_WATCH = [
  "Fault:Code", "Sync:ExitCause", "Drive:Mode", "Drive:Stage", "Freeze:State",
  "Feedback:State", "Feedback:RenderFreq", "Foc:EntryFreq", "Sync:Lock", "Sync:ErrPeak",
  "Foc:LockErr", "Meas:CurrAvg", "Speed:DerateCurr", "Meas:Temp", "Speed:DerateTemp",
];

// What holds the drive back right now, one sentence per cause, read off the registers alone.
// An active fault outranks everything else, because nothing else is running.
// A reading that has not arrived yet says nothing rather than something wrong.
function ecNow() {
  const v = (name) => S.values[name];
  const code = v("Fault:Code");
  if(code && code !== "ok") {
    const fault = EC_FAULTS.find(f => f.codes.includes(code));
    const cause = v("Sync:ExitCause");
    const exit = code === "sync" && EC_EXIT[cause]
      ? `Sync:ExitCause = ${cause}: ${EC_EXIT[cause]}.`
      : "";
    return [[`Fault:Code = ${code}.`, fault?.text, exit].filter(Boolean).join(" ")];
  }
  const out = [];
  const mode = v("Drive:Mode");
  const stage = v("Drive:Stage");
  const freeze = v("Freeze:State");
  if(mode !== "vf" && EC_WHY[stage]) out.push(EC_WHY[stage]);
  // The ramp stops at the takeover point without a freeze when the command is that point,
  // so standing there in `forced` is the wait whatever `Freeze:State` says.
  const entry = v("Foc:EntryFreq"), render = v("Feedback:RenderFreq");
  const waiting = stage === "forced" && mode === "foc" && entry > 0
    && Math.abs(render - entry) < EC_ENTRY_TOL_Hz;
  if(waiting) {
    const lock = v("Sync:Lock");
    const peak = v("Sync:ErrPeak"), gate = v("Foc:LockErr");
    let line = "Rampa czeka na przejęcie przy Foc:EntryFreq";
    line += lock == null ? "." : `: Sync:Lock ${lock} z ${EC_LOCK_FULL}.`;
    if(peak != null && gate > 0 && peak >= gate) line += " Sync:ErrPeak przekracza Foc:LockErr.";
    out.push(line);
  }
  else if(freeze === "hold") {
    out.push("Rampa czeka: wektor napięcia doszedł do Foc:ModCeil, więc napęd nie przyspieszy "
      + "wyżej. Freeze:HoldCount liczy takie wstrzymania.");
  }
  else if(EC_FREEZE[freeze]) out.push(EC_FREEZE[freeze]);
  if(v("Feedback:State") === "run") {
    const curr = v("Meas:CurrAvg"), derateCurr = v("Speed:DerateCurr");
    if(derateCurr > 0 && curr >= derateCurr) {
      out.push("Prędkość ograniczona prądem: Meas:CurrAvg osiągnął Speed:DerateCurr.");
    }
    const temp = v("Meas:Temp"), derateTemp = v("Speed:DerateTemp");
    if(derateTemp > 0 && temp >= derateTemp) {
      out.push("Prędkość ograniczona temperaturą: Meas:Temp osiągnęła Speed:DerateTemp.");
    }
  }
  return out;
}

//------------------------------------------------------------------------------------------ Stages

// `\n` starts a paragraph.
// `find` is a strict search query, `|` joining alternatives,
// so a stage leaves exactly its own registers lit in the grid.
// `table` is the one the tables panel is asked to open, where the stage works on one.
const EC_INTRO =
  "Ten panel prowadzi krok po kroku przez uruchomienie i strojenie napędu PMSM. "
  + "Wybierz etap, a Modra pokaże potrzebne rejestry i wykresy. Kliknij aktywny etap "
  + "ponownie, aby wrócić do własnego widoku."
  + "\n"
  + "Ctrl:Mode wybiera źródło i jednostkę wartości zadanej: ai to wejście analogowe, "
  + "% to procent zakresu, rpm to obroty na minutę, a Hz to częstotliwość. Wartość "
  + "off zatrzymuje napęd. Ctrl:Setpoint podaje wartość w wybranej jednostce. "
  + "Zapis Ctrl:Mode zeruje Ctrl:Setpoint, więc wartość zadaną wpisuj po wyborze trybu."
  + "\n"
  + "Drive:Mode wybiera tryb sterowania: vf to sterowanie skalarne według tabeli "
  + "Volt, if to sterowanie prądowe z wymuszonym kątem, a foc po synchronizacji "
  + "zamyka pętlę wektorową. Zmiana działa od razu, a w pętli zamkniętej od następnego "
  + "startu. Drive:Stage pokazuje etap rzeczywiście używany przez napęd, a gdy sterowanie "
  + "wektorowe się nie uruchomi, podaje powód."
  + "\n"
  + "Ramka nad tekstem opisuje na bieżąco, co ogranicza napęd: aktywny błąd, wstrzymanie "
  + "rampy, ograniczanie prędkości albo oczekiwanie na przejęcie."
  + "\n"
  + "Nazwy rejestrów w tekście są klikalne. Najedź kursorem, aby wskazać wiersz w "
  + "siatce, albo kliknij, aby do niego przejść.";

const EC_STAGES = [

  {
    id: "dane", label: "1 Dane",
    find: "Motor:|Sense:PhaseMap|Sense:Shunt|Trim:CurrScale|Obs:DtMeas|Meas:Speed",
    mute: EC_MUTE,
    plot: ["Foc:GuardId", "Foc:GuardIdRef"], big: [],
    text:
      "Cel: wpisać dane silnika i sprawdzić tor pomiaru prądu. Bez Motor:Rs napęd pracuje "
      + "tylko w V/f. Bez Motor:Ke działa tryb if, a foc pozostaje na V/f z Drive:Stage = obs."
      + "\n"
      + "Motor:Rs to połowa rezystancji zmierzonej między dwoma zaciskami falownika, razem "
      + "z kablem. Motor:Lq to połowa największego odczytu miernika LCR między dwoma zaciskami "
      + "podczas obracania wału, w paśmie od 100Hz do 1kHz. Mierz złożony silnik: sam stojan "
      + "bez wirnika daje około 2.5 raza mniejszą indukcyjność. "
      + "Motor:PolePairs to liczba par biegunów, nie biegunów. Motor:Ke to międzyfazowe "
      + "napięcie RMS przy 1000rpm, z karty silnika albo z pomiaru wybiegu przy odłączonym "
      + "mostku."
      + "\n"
      + "Meas:Speed to prędkość wału wyliczona z częstotliwości i Motor:PolePairs. Porównaj ją "
      + "z tachometrem: dwukrotna różnica oznacza błędną liczbę par biegunów, a z nią błędne "
      + "skale obserwatora."
      + "\n"
      + "Motor:Invert zmienia kierunek obrotów. Sense:PhaseMap opisuje znaki i kolejność "
      + "kanałów prądowych na płytce. To dwa niezależne ustawienia: zamiana przewodów "
      + "silnika nie zmienia torów pomiarowych falownika. Płytka zmontowana zgodnie ze "
      + "schematem pracuje z wartością norm. Pozostałe wartości korygują błąd okablowania "
      + "egzemplarza: s zamienia kanały U i V, a i odwraca znak wymienionych faz, na przykład "
      + "iV albo siUVW."
      + "\n"
      + "Jeżeli Drive:Stage pokazuje guard, napęd odrzucił tor prądu przy starcie i pracuje "
      + "według tabeli V/f. Porównaj Foc:GuardId z Foc:GuardIdRef. Odczyt bliski zera przy "
      + "niezerowej wartości zadanej oznacza brak pomiaru: sprawdź okablowanie i ciągłość "
      + "kanału. Przeciwny znak albo duża różnica wskazuje błędne Sense:PhaseMap. Zmieniaj "
      + "jedno ustawienie lub połączenie naraz i po każdej zmianie wykonaj krótki rozruch."
      + "\n"
      + "Sprawdź Sense:ShuntRes i Sense:ShuntGain. Błędna skala nie wywoła błędu, ale "
      + "zafałszuje tabelę Curr, progi prądu i wszystkie późniejsze pomiary. Rejestry "
      + "prądowe podają skuteczny prąd fazowy, czyli wartość, którą pokazują cęgi na "
      + "przewodzie fazowym. Niewielką różnicę skoryguj Trim:CurrScale."
      + "\n"
      + "Obs:DtMeas to czas martwy mostka zmierzony podczas ustawiania wirnika, czyli przy "
      + "starcie z If:CatchFreq = 0 i Drive:AlignTime nie krótszym niż około 210ms. Na "
      + "stojącym wirniku silnika 1.5kW odczyt wynosił 1850–2090ns, a na wirniku jeszcze "
      + "obracającym się około 1300–1450ns. Zaniżony odczyt oznacza start przed zatrzymaniem "
      + "wentylatora."
      + "\n"
      + "Zakończ etap, gdy MeasCtrl:CurrAvg zgadza się z cęgami, a Meas:Speed z tachometrem.",
  },

  {
    id: "vf", label: "2 V/f",
    table: "Volt",
    find: "Volt:|MeasCtrl:CurrAvg|Drive:InitFreq|Brake:Coast",
    mute: EC_MUTE_VF,
    plot: ["Feedback:Volt", "Feedback:ModIndex"], big: ["MeasCtrl:CurrAvg"],
    text:
      "Cel: dobrać tabelę Volt. Ustaw Drive:Mode = vf. Napięcie wynika wtedy wprost "
      + "z tabeli i nic go nie koryguje w trakcie pracy. W trybach if i foc ta sama tabela "
      + "prowadzi rozruch do If:CatchFreq (stan catch) oraz pracę zastępczą, gdy Drive:Stage "
      + "podaje powód odmowy sterowania wektorowego. Pracę w całym zakresie prowadzi FOC."
      + "\n"
      + "Dobieraj punkty przy stałej prędkości. Obserwuj MeasCtrl:CurrAvg, zmieniaj najbliższy "
      + "punkt o krok w dół albo w górę i po każdej zmianie czekaj, aż odczyt się ustali. "
      + "Najmniejszy prąd oznacza strumień dopasowany do obciążenia. Poniżej minimum rośnie "
      + "kąt obciążenia i maleje zapas do wypadnięcia z synchronizmu, dlatego zostaw punkt "
      + "około 5% nad minimum. Meas:CurrAvg to wolny odczyt używany do ograniczania "
      + "prędkości; przy tej regulacji reaguje zbyt późno."
      + "\n"
      + "Zielona linia w panelu tabel pokazuje bieżącą częstotliwość, a zielona kropka "
      + "napięcie rzeczywiście przyłożone do silnika. Od postoju do 2Hz obowiązuje Volt:2Hz, "
      + "dlatego ten punkt decyduje o obciążonym rozruchu i o końcu zatrzymania."
      + "\n"
      + "Rampa zaczyna się od Drive:InitFreq, a moment rozruchowy wynika wyłącznie z tabeli, "
      + "bo prąd nie jest jeszcze regulowany. Za niskie Volt:2Hz daje za mały moment "
      + "i przypadkowe położenie wirnika na starcie, a za wysokie zwiększa prąd do zadziałania "
      + "irms albo stall. Mapa, czyli domyślne nastawy wariantu 1.5kW, ma Volt:2Hz = 19.4V, "
      + "a przy 25V każdy start na stanowisku kończył się błędem irms."
      + "\n"
      + "Startuj na stojącym wirniku. Start na obracający się wentylator pompuje szynę DC "
      + "i kończy się błędem hv+. Brake:Coast jest również najkrótszą przerwą przed ponownym "
      + "startem, więc nie powinien być krótszy niż wybieg wentylatora."
      + "\n"
      + "Zakończ etap, gdy silnik pewnie rusza, a prąd w zakresie V/f pozostaje niski "
      + "i powtarzalny.",
  },

  {
    id: "if", label: "3 I/f",
    table: "Curr",
    find: "If:|Curr:|Foc:IqMax|Drive:AlignTime|MeasCtrl:CurrAvg",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Estim:Freq", "Feedback:Volt", "Obs:AngleErr"], big: ["Foc:IqCmd"],
    text:
      "Cel: sprawdzić sterowanie prądowe przy wymuszonym kącie. Ustaw Drive:Mode = if. "
      + "Tabela Curr wyznacza wartość zadaną prądu, a kąt elektryczny nadal wyznacza rampa. "
      + "Prawidłowy stan to Drive:Stage = forced. Obserwator pracuje wtedy w tle, ale jeszcze "
      + "nie steruje silnikiem."
      + "\n"
      + "If:CatchFreq wybiera sposób startu. Wartość dodatnia rozpędza silnik według tabeli "
      + "Volt i przy tej częstotliwości przekazuje go pętli prądu; taki start przejmuje "
      + "również obracający się wirnik, ale nie mierzy straty mostka. Wartość zero ustawia "
      + "wirnik pod znanym kątem przez Drive:AlignTime i mierzy przy tym czas martwy "
      + "(Obs:DtMeas). Mapa startuje przez catch przy 12.5Hz."
      + "\n"
      + "Foc:IqCmd pokazuje zadany prąd, a MeasCtrl:CurrAvg zmierzony; po ustaleniu powinny "
      + "być zbliżone. Duża różnica oznacza, że pętla prądu nie osiąga wartości zadanej: "
      + "sprawdź skalę pomiaru prądu i zapas napięcia, nie tabelę Curr. Curr:2Hz ustala prąd "
      + "ustawiania wirnika i początek profilu, a Foc:IqMax ogranicza w I/f cały prąd."
      + "\n"
      + "Moment w I/f to prąd razy sinus kąta obciążenia. Najmniejszy prąd, przy którym "
      + "wirnik nie wypada z synchronizmu, pomnożony przez 1.4 zostawia 45° zapasu kąta. "
      + "Wypadnięcie z synchronizmu oddaje energię wirnika do szyny DC, tym więcej, im wyższa "
      + "prędkość, i kończy się błędem hv+."
      + "\n"
      + "Obs:AngleErr w I/f to kąt estymaty względem wymuszonego pola: kąt obciążenia razem "
      + "z błędem obserwatora, który na stanowisku przeważał. Nie dobieraj według niego "
      + "tabeli Curr. Znaczenie ma w punkcie przejęcia, gdzie opóźnienie ponad 105° oznacza "
      + "stan B (etap 5)."
      + "\n"
      + "Błąd spin oznacza wirnik, który nie nadąża za polem. Od 15Hz napęd porównuje "
      + "estymatę prędkości z połową częstotliwości rampy, także gdy wirnik obraca się wstecz. "
      + "Gdy Curr:40Hz nie jest mniejsze niż Curr:15Hz, sprawdza również, czy moc pozorna rośnie "
      + "między tymi częstotliwościami. Mapa 1.5kW ma Curr:15Hz nieco powyżej Curr:40Hz, więc "
      + "kontrola mocy jest tam wyłączona. Po zmianie tej części tabeli wykonaj pełny rozruch "
      + "i sprawdź, czy nie pojawia się błąd spin."
      + "\n"
      + "Dobierz If:Damp. Obserwuj Estim:Freq, bo to jedyny odczyt prędkości niezależny od "
      + "rampy. Jeżeli prędkość faluje wokół zadanej, zwiększaj tłumienie małymi krokami. "
      + "Szukaj najmniejszej wartości, która wygasza wahania bez wzbudzania nowych. Zero "
      + "wyłącza tłumienie."
      + "\n"
      + "Zakończ etap, gdy w wymaganym zakresie prąd zmierzony zgadza się z zadanym, a praca "
      + "jest stabilna i bez oscylacji.",
  },

  {
    id: "obs", label: "4 Obserwator",
    find: "Obs:|Pll:",
    mute: EC_MUTE,
    plot: ["Obs:Bias", "Sync:ErrPeak", "Obs:OmegaHat", "Obs:AngleErr", "Obs:OmegaRipple"],
    big: ["Obs:Bias"],
    text:
      "Cel: sprawdzić obserwator, zanim przejmie sterowanie. Pozostaw Drive:Mode = if; "
      + "obserwator pracuje wtedy w tle. W planowanym zakresie przejęcia porównuj "
      + "Obs:OmegaHat z Feedback:RenderFreq. Obs:Bias, średnia różnica prędkości obserwatora "
      + "i rampy, powinien pozostawać blisko zera."
      + "\n"
      + "Zacznij od domyślnych nastaw; dla 1.5kW są to Obs:DtComp 80%, Obs:HpHz 1.6Hz, "
      + "Pll:Bw 15Hz i Pll:Damp 0.71. Na stanowisku Pll:Bw 10, 15 i 20Hz dawały w pętli "
      + "zamkniętej ten sam wynik. Szersze pasmo przenosi tętnienie estymaty na prędkość, którą "
      + "odczytuje regulator; za szerokie Pll:Bw widać w Obs:OmegaRipple jako kilka Hz."
      + "\n"
      + "Obs:DtComp kompensuje w obserwatorze stratę mostka. 100% oznacza stratę zmierzoną "
      + "przy ustawianiu wirnika (Obs:DtMeas), a bez pomiaru, czyli po starcie przez catch, "
      + "wartość wynikającą z Pwm:Deadtime. Pomiar na silniku 1.5kW dał 1.85–2.09µs wobec "
      + "nominalnych 2.5µs, dlatego mapa ma 80% dla startu przez catch. Przy starcie "
      + "z ustawieniem wirnika wpisz 100%."
      + "\n"
      + "Nastawy obserwatora oceniaj próbami przejęcia, nie odczytami z I/f. Słabsza "
      + "kompensacja obniża Sync:ErrPeak w I/f, choć w pętli zamkniętej kompensacja 0 wypadała "
      + "gorzej niż 100%. Różnice Sync:ErrPeak między nastawami bywały "
      + "mniejsze niż między dwoma pomiarami tych samych nastaw."
      + "\n"
      + "Stały Obs:Bias, którego nie usuwa rozsądna kompensacja, wskazuje błędne Motor:Ke, "
      + "Sense:PhaseMap albo skalę prądu. Nie poszerzaj warunków przejęcia, aby ukryć błędną "
      + "estymację."
      + "\n"
      + "Sync:ErrPeak rośnie z prądem, więc samo minimum szczytu wskazuje małą częstotliwość "
      + "i mały prąd. Na stanowisku 1.5kW punkt przejęcia wybrano przy 45Hz i taką wartość "
      + "Foc:EntryFreq ma mapa; większe warianty mają 55Hz."
      + "\n"
      + "Zakończ etap, gdy Obs:OmegaHat stabilnie podąża za Feedback:RenderFreq, a Obs:Bias "
      + "pozostaje blisko zera w całym zakresie przejęcia.",
  },

  {
    id: "sync", label: "5 Przejęcie",
    find: "Foc:Entry|Foc:Lock|Foc:SlipMax|Foc:TakeoverDelta|Sync:",
    mute: EC_MUTE,
    plot: ["Sync:Lock", "Sync:ErrPeak", "Foc:LockErr", "Obs:OmegaHat", "Foc:TakeoverDelta"],
    big: ["Sync:Lock"],
    text:
      "Cel: zapewnić powtarzalne przekazanie sterowania obserwatorowi. Przejście z forced do "
      + "closed wymaga Drive:Mode = foc oraz niezerowych Foc:EntryFreq i Foc:LockErr. Rampa "
      + "najpierw dochodzi do Foc:EntryFreq i zatrzymuje się tam do przejęcia, także gdy "
      + "wartość zadana jest niższa. Do celu napęd przechodzi dopiero w pętli zamkniętej."
      + "\n"
      + "Sync:Lock zbiera potwierdzenia co 10ms: zgodna próbka dodaje 1, a niezgodna odejmuje "
      + "4. Próbka jest zgodna, gdy chwilowy błąd kąta mieści się w Foc:LockErr, a prędkość "
      + "obserwatora odbiega od częstotliwości rampy o mniej niż Foc:LockSpeed procent. "
      + "Po osiągnięciu Sync:Lock = " + EC_LOCK_FULL + " przejęcie następuje, gdy błąd kąta "
      + "spadnie poniżej połowy Foc:LockErr, najwcześniej po 400ms. Oceniaj je według "
      + "Sync:ErrPeak, nie Sync:Err: średnia może wyglądać poprawnie mimo chwilowych skoków."
      + "\n"
      + "Foc:LockErr ustaw około 8° powyżej Sync:ErrPeak zmierzonego w punkcie przejęcia; mapa "
      + "1.5kW ma 60°. Foc:LockSpeed pozostaw na 40%. Jeżeli Sync:Lock nie dochodzi do końca, "
      + "choć Sync:ErrPeak jest mniejszy niż Foc:LockErr, najpierw poszerz Foc:LockSpeed, "
      + "a dopiero potem Foc:LockErr. Nie rozszerzaj tolerancji wyłącznie po to, aby wymusić "
      + "przejście."
      + "\n"
      + "Stan B: w punkcie przejęcia estymata pozostaje za polem dalej, niż pozwala obciążenie, "
      + "a Obs:AngleErr pokazuje ponad 105° opóźnienia. Napęd nie przejmuje sterowania, po "
      + "0.5s przechodzi w wybieg bez błędu i startuje ponownie; Sync:Restarts liczy te "
      + "rozbiegi. Czwarty rozbieg z rzędu przejmuje sterowanie mimo stanu B. Na stanowisku "
      + "stan B występował głównie po starcie na obracającym się wirniku."
      + "\n"
      + "Foc:TakeoverDelta to kąt, o który przejęcie obraca układ współrzędnych: z kąta "
      + "wymuszonego na kąt obserwatora. Na stanowisku pętle trwałe miały 61–97°, a tracone "
      + "po kilkudziesięciu milisekundach 119–150°. Przy dużym kącie pomaga większy prąd "
      + "w punkcie przejęcia (tabela Curr), a nie większa tolerancja przejęcia."
      + "\n"
      + "Foc:EntryTimeout ogranicza oczekiwanie po dojściu do Foc:EntryFreq; po jego upływie "
      + "napęd zgłasza błąd sync i nie kontynuuje pracy w I/f. Zero oznacza oczekiwanie bez "
      + "ograniczenia."
      + "\n"
      + "Z pętli zamkniętej nie ma powrotu do I/f: utrata pętli kończy się błędem sync "
      + "i wybiegiem. Sync:ExitCause podaje przyczynę: "
      + Object.entries(EC_EXIT).map(([cause, means]) => `${cause}, gdy ${means}`).join("; ")
      + ". Sync:ExitTime podaje czas trwania pętli, a Sync:Takeovers i Sync:Losses liczą "
      + "przejęcia i utraty."
      + "\n"
      + "Zakończ etap, gdy kolejne starty przejmują sterowanie za pierwszym razem, bez błędu "
      + "sync i bez skoków prądu.",
  },

  {
    id: "foc", label: "6 FOC",
    find: "Foc:Curr|Foc:Iq|Foc:Mod|Foc:Flags|SpeedCtrl:|Speed:Derate|Freeze:State|Freeze:Hold",
    mute: EC_MUTE,
    plot: [
      "Foc:IqCmd", "Obs:OmegaHat", "Feedback:ModIndex",
      "Obs:Bias", "Meas:CurrAvg", "Freeze:State",
    ],
    big: ["Foc:IqCmd"],
    text:
      "Cel: dostroić pętlę zamkniętą i sprawdzić górę zakresu. Przy Drive:Stage = closed kąt "
      + "elektryczny wyznacza obserwator, a regulator prędkości zadaje prąd osi q, ograniczony "
      + "przez Foc:IqMax. Regulator nie wytwarza momentu hamującego: wentylator zwalnia pod "
      + "własnym obciążeniem."
      + "\n"
      + "Foc:CurrBw ustala pasmo pętli prądu, a jej nastawy wynikają z Motor:Rs i Motor:Lq. "
      + "Pozostaw wartość domyślną, chyba że odpowiedź prądu jest za wolna albo zaczyna "
      + "falować. Foc:IqCmd i MeasCtrl:CurrAvg powinny się pokrywać."
      + "\n"
      + "Pętlę prędkości strój na końcu, zmieniając po jednym parametrze. SpeedCtrl:Kp ustala "
      + "szybkość reakcji, a SpeedCtrl:Ki usuwa uchyb ustalony. W pętli zamkniętej Obs:Bias "
      + "pokazuje uchyb regulatora prędkości. Mapa 1.5kW ma SpeedCtrl:Kp = 150; przy 75 rozrzut "
      + "Obs:Bias na stanowisku był większy. Jeżeli prędkość zaczyna falować, cofnij ostatnią "
      + "zmianę."
      + "\n"
      + "Prąd wentylatora rośnie w przybliżeniu z kwadratem prędkości, a moc z sześcianem. "
      + "Na stanowisku 1.5kW prąd momentu wynosił 0.47A przy 40Hz, 1.02A przy 80Hz i 1.54A "
      + "przy 100Hz. Od Speed:DerateCurr, porównywanego z Meas:CurrAvg, napęd liniowo obniża "
      + "limit prędkości w stronę Speed:DerateLimit i osiąga go przy Thresh:CurrRms. Tak samo "
      + "działa Speed:DerateTemp dla temperatury. To ograniczenie bez błędu: napęd przestaje "
      + "przyspieszać."
      + "\n"
      + "Gdy wektor napięcia dochodzi do Foc:ModCeil, Foc:Flags pokazuje sat, a rampa "
      + "zatrzymuje się z Freeze:State = hold, zamiast oddalać się od wirnika i dociskać "
      + "regulator do Foc:IqMax. Freeze:HoldCount liczy takie wstrzymania. Foc:Flags "
      + "podtrzymuje przez około 2s także flagę limit, czyli osiągnięcie Foc:IqMax."
      + "\n"
      + "Na stanowisku 1.5kW napęd osiągnął 190Hz przy 3.6A i mocy pozornej około 1.3kVA, "
      + "ograniczany przez Speed:DerateCurr. Szczyty prądu sięgały tam 7.0A, tuż pod progiem "
      + "wyłączenia, bo tętnienie prądu leży poza pasmem pętli prądu. Nie podnoś więc "
      + "Speed:DerateCurr ani progów prądu, aby uzyskać wyższą prędkość."
      + "\n"
      + "Zakończ etap, gdy odpowiedź na zmianę wartości zadanej jest szybka i bez oscylacji, "
      + "a flagi limit i sat pojawiają się tylko na górze zakresu.",
  },

  {
    id: "rampy", label: "7 Rampy",
    table: "Rise",
    find: "Rise:|Fall:|Brake:|Freeze:Vdc|Bus:Max",
    mute: EC_MUTE,
    plot: ["MeasCtrl:DcBus", "Thresh:DcBusMax", "Freeze:VdcHigh", "Freeze:VdcLow"],
    big: ["MeasCtrl:DcBus"],
    text:
      "Cel: dobrać tempo rozpędzania i zwalniania. Tabela Rise ustala tempo rozpędzania, "
      + "a Fall zwalniania, obie w punktach częstotliwości; tempo jest odczytywane przy "
      + "bieżącej częstotliwości. Najpierw ustaw Rise, potem Fall. Po zmianie punktu "
      + "powtarzaj ten sam cykl, aby porównać wyniki."
      + "\n"
      + "Przy rozpędzaniu obserwuj MeasCtrl:CurrAvg i flagę limit w Foc:Flags. Szyna DC "
      + "opada pod obciążeniem, na stanowisku 1.5kW o około 4.7V na każde 100W. Freeze:VdcLow "
      + "wstrzymuje przyspieszanie, gdy szyna spadnie poniżej progu, więc musi leżeć poniżej "
      + "napięcia szyny w najwyższym punkcie pracy; mapa 1.5kW ma 530V, 10V powyżej "
      + "Thresh:DcBusMin."
      + "\n"
      + "W pętli zamkniętej tabela Fall szybsza od naturalnego zwalniania wentylatora "
      + "sprowadza prąd momentu do zera. Przy prądzie około 0.1A obserwator traci "
      + "synchronizację z wirnikiem i napęd zgłasza błąd sync. Wentylator 1.5kW bez napędu "
      + "zwalnia o około 2.8Hz/s przy 40Hz i 3.4Hz/s przy 50Hz; tabela Fall powinna pozostać "
      + "poniżej tych wartości."
      + "\n"
      + "W V/f i I/f zwalnianie oddaje energię wirnika do szyny DC, bo mostek diodowy nie "
      + "może jej odprowadzić. Freeze:VdcHigh wstrzymuje wtedy zwalnianie, a Freeze:State "
      + "pokazuje hv+. Częste wstrzymania oznaczają zbyt szybką tabelę Fall. Jeżeli błąd hv+ "
      + "pojawia się przed wstrzymaniem rampy, obniż Freeze:VdcHigh. Thresh:DcBusMax to próg "
      + "błędu; nie podnoś go, aby skompensować zbyt gwałtowne hamowanie."
      + "\n"
      + "Ctrl:Mode = off w pętli zamkniętej sprowadza napęd tabelą Fall do Speed:Min i tam "
      + "wyłącza mostek. Bus:Max pokazuje najwyższe napięcie szyny od startu."
      + "\n"
      + "Zakończ etap, gdy pełne cykle rozpędzania i zwalniania przebiegają bez błędów "
      + "i częstych wstrzymań rampy.",
  },

  {
    id: "bledy", label: "8 Błędy",
    find: "Fault:|Thresh:|Bus:Max",
    mute: EC_MUTE,
    plot: ["Fault:Code", "Fault:PeakEvents", "MeasCtrl:DcBus", "Bus:Max"], big: [],
    text:
      "Cel: rozpoznać błąd z Fault:Code. Fault:Freq, Fault:Curr, Fault:Vdc i Fault:Temp "
      + "przechowują wartości z chwili błędu."
      + EC_FAULTS.map(f => "\n" + f.codes.join(" i ") + ": " + f.text).join("")
      + "\n"
      + "Fault:Clear kasuje błąd; jeśli przyczyna trwa, błąd wróci. Napęd sam ponawia start "
      + "najwyżej Fault:RetryCount razy."
      + "\n"
      + "Nie podnoś progów, aby błąd zniknął.",
  },
];

//-------------------------------------------------------------------------------------------- Book

const Ectra = {

  id: "ectra-guide",
  title: "Ectra · Strojenie PMSM",
  icon: "📖",
  beside: true,

  _stage: null,

  match(regs) {
    return ["Obs:DtComp", "Sync:Lock", "Drive:Stage"]
      .every(n => regs.some(r => r.name === n));
  },

  // Picking a stage aims the whole app at it;
  // dropping it hands the operator their own view back, filter, charts and ignore list alike.
  pick(id) {
    this._stage = id === this._stage ? null : id;
    const st = EC_STAGES.find(s => s.id === this._stage);
    if(st) {
      Widgets.focus(EC_FIND_ALWAYS + "|" + st.find);
      Widgets.plot(EC_ALWAYS.concat(st.plot), EC_BIG.concat(st.big));
      Widgets.mute(st.mute, ecNamed(st.text).concat(EC_FIND_ALWAYS.split("|"), EC_WATCH));
      // Three stages work on a table.
      // Asking for it is a courtesy to the panel next door, not a requirement:
      // the guide reads the same either way.
      if(st.table) Widgets.tell("ectra-tables", { table: st.table });
    }
    else Widgets.release();
    try { localStorage.setItem(EC_STAGE_KEY, this._stage || ""); }
    catch(e) { /* per-session */ }
    render();
  },

  // A register named in the prose, and a way to it.
  // Hovering marks that row in the grid, clicking takes you there and leaves it marked.
  // Only a name the map carries becomes a link, so a group prefix stays plain text.
  Name({ of }) {
    if(!Reg.byName(of)) return <b>{of}</b>;
    return (
      <b class="ec-ref" onMouseEnter={() => Widgets.point(of)}
        onClick={() => Widgets.reveal(of)}>
        {of}
      </b>
    );
  },

  // A paragraph with its register names as links
  Para({ text }) {
    const { Name } = Ectra;
    const parts = text.split(new RegExp("(" + EC_NAME + ")")); // names at odd indices
    return <p>{parts.map((t, i) => i % 2 ? <Name of={t} /> : t)}</p>;
  },

  // What holds the drive back right now, between the tabs and the prose
  Now({ lines }) {
    const { Para } = Ectra;
    return (
      <div class="ec-now" onMouseLeave={() => Widgets.point(null)}>
        {lines.map(line => <Para text={line} />)}
      </div>
    );
  },

  View() {
    const { Now, Para } = Ectra;
    const stage = EC_STAGES.find(s => s.id === this._stage);
    const now = ecNow();
    return (
      <div class="ec ec-book">
        <div class="ec-tabs">
          {EC_STAGES.map(s =>
            <button class={cls("ec-tab", s.id === this._stage && "on")}
              onClick={() => Ectra.pick(s.id)}>
              {s.label}
            </button>)}
        </div>
        {now.length > 0 && <Now lines={now} />}
        <div class="ec-text" onMouseLeave={() => Widgets.point(null)}>
          {(stage ? stage.text : EC_INTRO).split("\n").map(par => <Para text={par} />)}
        </div>
      </div>
    );
  },
};

try { Ectra._stage = localStorage.getItem(EC_STAGE_KEY) || null; }
catch(e) { /* defaults stand */ }
if(!EC_STAGES.some(s => s.id === Ectra._stage)) Ectra._stage = null;

Widgets.register(Ectra);
