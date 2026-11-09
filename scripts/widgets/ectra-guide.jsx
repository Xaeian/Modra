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
// The ones the config file carries still arrive with every full sync.
//
// `Flow` and `Journal` alone are more than half the registers,
// and no other group comes close.
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
  // Charted as well as lit, because the counter beside it says
  // how many takeovers there were and never when.
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
  slip: "częstotliwość obserwatora przekroczyła częstotliwość rampy o więcej niż Foc:SlipMax "
    + "albo spadła poniżej jej połowy",
  unlock: "obserwator utracił synchronizację kąta",
  weak: "zapadł się strumień",
  config: "konfiguracja unieważniła obserwator",
};

// Every cause in one sentence, as the takeover page lists them
const EC_EXIT_LIST = Object.entries(EC_EXIT)
  .map(([cause, means]) => `${cause}, gdy ${means}`)
  .join("; ");

// Every `Fault:Code`, what tripped it and the first thing to check, in code order.
// Each is listed on its `stage` in this order, and the live note quotes the one that is active.
// `feed` closes the list: it is a journal event and never shows in `Fault:Code`.
const EC_FAULTS = [
  {
    codes: ["peak"], stage: "bledy",
    text:
      "Licznik komparatora prądu Fault:PeakEvents osiągnął Thresh:PeakCount. "
      + "Prąd w punkcie pracy jest za duży: "
      + "w V/f tabela Volt odbiega od minimum prądu, "
      + "w I/f tabela Curr jest za wysoka, a w FOC Foc:IqMax; "
      + "przyczyną może być też za duże obciążenie.",
  },
  {
    codes: ["imax"], stage: "bledy",
    text:
      "Amplituda prądu fazy (połowa MeasCtrl:PeakMax) ponad Thresh:CurrPeak. "
      + "Sprawdź tabelę i obciążenie.",
  },
  {
    codes: ["irms"], stage: "bledy",
    text:
      "MeasCtrl:CurrAvg ponad Thresh:CurrRms. "
      + "Sprawdź tabelę, obciążenie i Speed:DerateCurr; "
      + "w FOC Foc:IqMax większy od Thresh:CurrRms pozwala przekroczyć próg.",
  },
  {
    codes: ["stall"], stage: "bledy",
    text:
      "Na tabeli V/f przez Thresh:StallTime prąd przekraczał Thresh:StallCurr "
      + "przy częstotliwości poniżej Thresh:StallFreq albo wirnik stał pod wirującym polem. "
      + "Fault:Freq poniżej 10Hz wskazuje warunek prądu: zmniejsz dół tabeli Volt. "
      + "Fault:Freq nie mniejsza od Thresh:StallFreq wskazuje stojący wirnik: "
      + "zwiększ Volt:0Hz albo zmniejsz tempo Rise.",
  },
  {
    codes: ["spin"], stage: "bledy",
    text:
      "W I/f wirnik nie nadąża za polem: "
      + "od 40Hz moc przez Thresh:SpinTime nie przekracza o Thresh:SpinPower poziomu z 15Hz "
      + "albo prędkość obserwatora przez 2s jest mniejsza od połowy rampy. "
      + "Sprawdź, czy wał obraca się swobodnie, "
      + "zwiększ tabelę Curr w tym zakresie albo zmniejsz tempo Rise. "
      + "Silnik bez obciążenia wentylatorem może nie osiągnąć przyrostu mocy: "
      + "zmniejsz wtedy albo wyzeruj Thresh:SpinPower.",
  },
  {
    codes: ["sync"], stage: "bledy",
    text:
      "Utrata synchronizacji w pętli zamkniętej, "
      + "brak przejęcia w czasie Foc:EntryTimeout albo faza bez prądu. "
      + "Sync:ExitCause (etap 5) opisuje tylko utratę synchronizacji.",
  },
  {
    codes: ["rpm"], stage: "bledy",
    text:
      "Przed rozruchem wirnik obracał się za szybko na hamowanie zwarciem "
      + "dłużej niż Brake:WaitMax wybiegu; "
      + "obroty z ostatniego sprawdzenia podaje Estim:Freq. "
      + "Wirnik może napędzać przeciąg albo drugi wentylator w kanale. "
      + "Dłuższy wybieg wymaga większego Brake:Coast albo Brake:WaitMax, "
      + "a hamowanie zwarciem od wyższych obrotów większego Brake:ShortCurr, "
      + "nie wyżej niż Thresh:CurrPeak.",
  },
  {
    codes: ["temp"], stage: "naped",
    text:
      "Temperatura stopnia mocy ponad Thresh:Temp. Sprawdź chłodzenie.",
  },
  {
    codes: ["hv-"], stage: "naped",
    text:
      "Napięcie szyny DC poniżej Thresh:DcBusMin. Sprawdź zasilanie.",
  },
  {
    codes: ["hv+"], stage: "naped",
    text:
      "Napięcie szyny DC ponad Thresh:DcBusMax przez 1s "
      + "albo ponad próg szybkiej ochrony, 30V niżej. "
      + "Przy zwalnianiu w V/f i I/f obniż Freeze:VdcHigh albo zwolnij tabelę Fall; "
      + "szybki wzrost do progu ochrony oznacza energię spoza rampy, "
      + "na przykład od wirnika tracącego synchronizm.",
  },
  {
    codes: ["bemf"], stage: "naped",
    text:
      "W FOC szczyt BEMF wyznaczony z Motor:Ke "
      + "doszedł do progu szybkiej ochrony szyny, 30V pod Thresh:DcBusMax. "
      + "Obniż Speed:Max poniżej tej prędkości albo sprawdź Motor:Ke, "
      + "bo zawyżony przesuwa granicę w dół.",
  },
  {
    codes: ["lv-", "lv+"], stage: "naped",
    text:
      "Napięcie zasilacza pomocniczego (Meas:Flyback) poza zakresem "
      + "od Thresh:FlybackMin do Thresh:FlybackMax.",
  },
  {
    codes: ["link"], stage: "naped",
    text:
      "Utrata komunikacji wewnętrznej napędu. "
      + "Gdy się powtarza (Counter:Link), wskazuje na problem sprzętowy.",
  },
  {
    codes: ["feed"], stage: "naped",
    text:
      "Nie pojawia się w Fault:Code, tylko w dzienniku: "
      + "kontrola toru prądu przy starcie przełączyła napęd "
      + "na tabelę V/f (Drive:Stage = guard, etap 1).",
  },
];

// The faults one stage lists, a paragraph each
function ecFaultLines(stage) {
  return EC_FAULTS
    .filter(f => f.stage === stage)
    .map(f => "\n" + f.codes.join(" i ") + ": " + f.text)
    .join("");
}

// `Drive:Stage` values that say why the table drives the bridge in `if` or `foc`.
// `off` is missing: it answers `Drive:Mode = vf`, which is no news.
const EC_WHY = {
  shunt: "Drive:Stage = shunt: tor pomiaru prądu nie ma skali (Sense:ShuntRes, Sense:ShuntGain), "
    + "więc mostek prowadzi tabela V/f.",
  obs: "Drive:Stage = obs: "
    + "brakuje danych silnika (Motor:Rs, Motor:Lq, w trybie foc także Motor:Ke), "
    + "więc mostek prowadzi tabela V/f.",
  volts: "Drive:Stage = volts: brakuje zapasu napięcia pod Foc:ModCeil, "
    + "więc mostek prowadzi tabela V/f.",
  guard: "Drive:Stage = guard: kontrola toru pomiaru prądu przy starcie się nie powiodła, "
    + "więc mostek prowadzi tabela V/f. "
    + "Sprawdź okablowanie i ciągłość kanałów prądu.",
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
  // After every cut the next start waits for part of the coast and a rotor check,
  // which on a fan still turning hard can take a long while with nothing else to show for it.
  if(v("Feedback:State") === "coa") {
    out.push("Silnik wybiega. "
      + "Rozruch jest możliwy po Brake:Wait czasu wybiegu i po sprawdzeniu obrotów wirnika, "
      + "których wynik podaje Estim:Freq.");
  }
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
    out.push("Rampa czeka: wektor napięcia doszedł do sufitu, więc napęd nie przyspieszy wyżej. "
      + "Sufit to Foc:ModCeil albo niższa granica od Pwm:Deadtime i Pwm:MinPulse. "
      + "Freeze:HoldCount liczy takie wstrzymania.");
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
  + "Wybierz etap, a Modra pokaże potrzebne rejestry i wykresy. "
  + "Kliknij aktywny etap ponownie, aby wrócić do własnego widoku."
  + "\n"
  + "Ctrl:Mode wybiera źródło i jednostkę wartości zadanej: "
  + "ai to wejście analogowe, % to procent zakresu, "
  + "rpm to obroty na minutę, a Hz to częstotliwość. "
  + "Wartość off odcina mostek i silnik wybiega. "
  + "Ctrl:Setpoint podaje wartość w wybranej jednostce, a 0 zatrzymuje silnik rampą. "
  + "Zmiana Ctrl:Mode odcina mostek i zeruje Ctrl:Setpoint, "
  + "więc wartość zadaną wpisuj po wyborze trybu; "
  + "ten sam tryb wpisany ponownie nic nie zmienia. "
  + "Po zmianie trybu w biegu napęd rusza z nową wartością zadaną dopiero po części wybiegu, "
  + "Brake:Wait czasu Brake:Coast, i po sprawdzeniu obrotów wirnika (etap 7)."
  + "\n"
  + "Drive:Mode wybiera tryb sterowania: "
  + "vf to sterowanie skalarne według tabeli Volt, if to sterowanie prądowe z wymuszonym kątem, "
  + "a foc po synchronizacji zamyka pętlę wektorową. "
  + "Zmiana działa od razu, a w pętli zamkniętej od następnego startu. "
  + "Drive:Stage pokazuje etap rzeczywiście używany przez napęd, "
  + "a gdy sterowanie wektorowe się nie uruchomi, podaje powód."
  + "\n"
  + "Ramka nad tekstem opisuje na bieżąco, co ogranicza napęd: "
  + "aktywny błąd, wybieg przed rozruchem, wstrzymanie rampy, "
  + "ograniczanie prędkości albo oczekiwanie na przejęcie."
  + "\n"
  + "Nazwy rejestrów w tekście są klikalne. "
  + "Najedź kursorem, aby wskazać wiersz w siatce, albo kliknij, aby do niego przejść.";

const EC_STAGES = [

  {
    id: "dane", label: "1 Dane",
    find: "Motor:|Sense:Shunt|Trim:CurrScale|Obs:DtMeas|Meas:Speed",
    mute: EC_MUTE,
    plot: ["Meas:Speed"], big: [],
    text:
      "Cel: wpisać dane silnika i sprawdzić tor pomiaru prądu. "
      + "Bez Motor:Rs napęd pracuje tylko w V/f. "
      + "Bez Motor:Ke działa tryb if, a foc pozostaje na V/f z Drive:Stage = obs."
      + "\n"
      + "Motor:Rs to połowa rezystancji zmierzonej "
      + "między dwoma zaciskami falownika, razem z kablem. "
      + "Motor:Ld i Motor:Lq to połowa najmniejszego i największego odczytu miernika LCR "
      + "między dwoma zaciskami podczas obracania wału, w paśmie od 100Hz do 1kHz. "
      + "Mierz złożony silnik: sam stojan bez wirnika daje około 2.5 raza mniejszą indukcyjność. "
      + "Motor:PolePairs to liczba par biegunów, nie biegunów. "
      + "Motor:Ke to międzyfazowe napięcie RMS przy 1000rpm, "
      + "z karty silnika albo z pomiaru na silniku odłączonym od napędu i obracanym z zewnątrz. "
      + "Napęd odrzuca Motor:Ke ponad 64.1V/krpm na parę biegunów, granicę skali obserwatora."
      + "\n"
      + "Meas:Speed to prędkość wału wyliczona z częstotliwości i Motor:PolePairs. "
      + "Porównaj ją z tachometrem: dwukrotna różnica oznacza błędną liczbę par biegunów, "
      + "a z nią błędne skale obserwatora. "
      + "Motor:Invert zmienia kierunek obrotów od następnego rozruchu."
      + "\n"
      + "Jeżeli Drive:Stage pokazuje guard, kontrola toru prądu przy starcie się nie powiodła "
      + "i napęd pracuje według tabeli V/f, a dziennik zapisuje zdarzenie feed. "
      + "Sprawdź okablowanie i ciągłość kanałów prądu. "
      + "Zmieniaj jedno połączenie naraz i po każdej zmianie wykonaj krótki rozruch."
      + "\n"
      + "Sprawdź Sense:ShuntRes, Sense:ShuntGain i Sense:ShuntTau, czyli dane płytki. "
      + "Błędna skala nie wywoła błędu, "
      + "ale zafałszuje tabelę Curr, progi prądu i wszystkie późniejsze pomiary. "
      + "MeasCtrl:CurrAvg i Meas:CurrAvg podają skuteczny prąd fazowy, "
      + "czyli wartość, którą pokazują cęgi na przewodzie fazowym. "
      + "Niewielką różnicę skoryguj Trim:CurrScale."
      + "\n"
      + "Obs:DtMeas to czas martwy mostka zmierzony podczas ustawiania wirnika, "
      + "czyli przy starcie z If:CatchFreq = 0 i Drive:AlignTime nie krótszym niż około 210ms. "
      + "Na stojącym wirniku silnika 1.5kW odczyt wynosił 1850–2090ns, "
      + "a na wirniku jeszcze obracającym się około 1300–1450ns. "
      + "Zaniżony odczyt oznacza start na jeszcze obracającym się wirniku."
      + "\n"
      + "Zakończ etap, gdy MeasCtrl:CurrAvg zgadza się z cęgami, a Meas:Speed z tachometrem.",
  },

  {
    id: "vf", label: "2 V/f",
    table: "Volt",
    find: "Volt:|MeasCtrl:CurrAvg|Drive:InitFreq|Drive:AlignTime",
    mute: EC_MUTE_VF,
    plot: ["Feedback:Volt", "Feedback:ModIndex"], big: ["MeasCtrl:CurrAvg"],
    text:
      "Cel: dobrać tabelę Volt. "
      + "Ustaw Drive:Mode = vf. "
      + "Napięcie wynika wtedy wprost z tabeli i nic go nie koryguje w trakcie pracy. "
      + "W trybach if i foc ta sama tabela prowadzi rozruch do If:CatchFreq (stan catch) "
      + "oraz pracę zastępczą, gdy Drive:Stage podaje powód odmowy sterowania wektorowego. "
      + "Pracę w całym zakresie prowadzi FOC."
      + "\n"
      + "Dobieraj punkty przy stałej prędkości. "
      + "Obserwuj MeasCtrl:CurrAvg, zmieniaj najbliższy punkt o krok w dół albo w górę "
      + "i po każdej zmianie czekaj, aż odczyt się ustali. "
      + "Najmniejszy prąd oznacza strumień dopasowany do obciążenia. "
      + "Poniżej minimum rośnie kąt obciążenia i maleje zapas do wypadnięcia z synchronizmu, "
      + "dlatego zostaw punkt około 5% nad minimum. "
      + "Meas:CurrAvg to wolny odczyt używany do ograniczania prędkości; "
      + "przy tej regulacji reaguje zbyt późno."
      + "\n"
      + "Zielona linia w panelu tabel pokazuje bieżącą częstotliwość, "
      + "a zielona kropka napięcie rzeczywiście przyłożone do silnika. "
      + "Volt:0Hz to napięcie postoju, którym rozruch ustawia wirnik przez Drive:AlignTime; "
      + "za niskie nie utrzymuje wirnika, a jego położenie na starcie jest wtedy przypadkowe. "
      + "Od 0Hz do 2Hz napięcie zmienia się liniowo do Volt:2Hz."
      + "\n"
      + "Rampa zaczyna się od Drive:InitFreq, a moment rozruchowy wynika wyłącznie z tabeli, "
      + "bo prąd nie jest jeszcze regulowany. "
      + "Za niski dół tabeli daje za mały moment, "
      + "a za wysoki zwiększa prąd do zadziałania irms albo stall. "
      + "Na stanowisku 1.5kW przy 25V na dole tabeli każdy start kończył się błędem irms."
      + "\n"
      + "Przed każdym rozruchem napęd sprawdza obroty wirnika (etap 7): "
      + "lekko obracający się wirnik zatrzymuje zwarciem, "
      + "a przy mocno obracającym się czeka w wybiegu. "
      + "Start V/f na obracający się wentylator podnosiłby napięcie szyny DC aż do błędu hv+. "
      + "Start przez catch w if i foc opisuje etap 3."
      + "\n"
      + "Zakończ etap, gdy silnik pewnie rusza, "
      + "a prąd w zakresie V/f pozostaje niski i powtarzalny.",
  },

  {
    id: "if", label: "3 I/f",
    table: "Curr",
    find: "If:|Curr:|Foc:IqMax|Drive:AlignTime|MeasCtrl:CurrAvg|Thresh:Spin",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Estim:Freq", "Feedback:Volt", "Obs:AngleErr"], big: ["Foc:IqCmd"],
    text:
      "Cel: sprawdzić sterowanie prądowe przy wymuszonym kącie. "
      + "Ustaw Drive:Mode = if. "
      + "Tabela Curr wyznacza wartość zadaną prądu, a kąt elektryczny nadal wyznacza rampa. "
      + "Prawidłowy stan to Drive:Stage = forced. "
      + "Obserwator pracuje wtedy w tle, ale jeszcze nie steruje silnikiem."
      + "\n"
      + "If:CatchFreq wybiera sposób startu. "
      + "Wartość dodatnia rozpędza silnik według tabeli Volt "
      + "i przy tej częstotliwości przekazuje go pętli prądu; "
      + "taki start przejmuje również obracający się wirnik, ale nie mierzy straty mostka. "
      + "Wartość zero ustawia wirnik pod znanym kątem przez Drive:AlignTime "
      + "i mierzy przy tym czas martwy (Obs:DtMeas). "
      + "Mapa startuje przez catch."
      + "\n"
      + "Foc:IqCmd pokazuje zadany prąd, a MeasCtrl:CurrAvg zmierzony; "
      + "po ustaleniu powinny być zbliżone. "
      + "Duża różnica oznacza, że pętla prądu nie osiąga wartości zadanej: "
      + "sprawdź skalę pomiaru prądu i zapas napięcia, nie tabelę Curr. "
      + "Curr:0Hz ustala prąd ustawiania wirnika i początek profilu, "
      + "a Foc:IqMax ogranicza cały prąd, w I/f i w FOC."
      + "\n"
      + "Moment w I/f to prąd razy sinus kąta obciążenia. "
      + "Najmniejszy prąd, przy którym wirnik nie wypada z synchronizmu, "
      + "pomnożony przez 1.4 zostawia 45° zapasu kąta. "
      + "Wypadnięcie z synchronizmu oddaje energię wirnika do szyny DC, "
      + "tym więcej, im wyższa prędkość, i kończy się błędem hv+."
      + "\n"
      + "Obs:AngleErr w I/f to kąt estymaty względem wymuszonego pola: "
      + "kąt obciążenia razem z błędem obserwatora, który na stanowisku przeważał. "
      + "Nie dobieraj według niego tabeli Curr. "
      + "Znaczenie ma w punkcie przejęcia, gdzie opóźnienie ponad 105° oznacza stan B (etap 5)."
      + "\n"
      + "Błąd spin oznacza wirnik, który nie nadąża za polem. "
      + "Od 15Hz napęd porównuje częstotliwość obserwatora z połową częstotliwości rampy, "
      + "także przy obrotach wstecz. "
      + "Od 40Hz sprawdza również, czy moc czynna przekracza o Thresh:SpinPower poziom z 15Hz, "
      + "zanim minie Thresh:SpinTime. "
      + "To kryterium nie działa, gdy tabela Curr zmniejsza prąd między 15Hz a 40Hz, "
      + "a mapa ma Curr:15Hz nieco powyżej Curr:40Hz we wszystkich wariantach. "
      + "Po zmianie tej części tabeli wykonaj pełny rozruch i sprawdź, "
      + "czy nie pojawia się błąd spin. "
      + "Silnik bez obciążenia wentylatorem może nie osiągnąć przyrostu mocy: "
      + "zmniejsz wtedy albo wyzeruj Thresh:SpinPower."
      + "\n"
      + "Dobierz If:Damp. "
      + "Obserwuj Estim:Freq, bo to jedyny odczyt prędkości niezależny od rampy. "
      + "Jeżeli prędkość faluje wokół zadanej, zwiększaj tłumienie małymi krokami. "
      + "Szukaj najmniejszej wartości, która wygasza wahania bez wzbudzania nowych. "
      + "Zero wyłącza tłumienie."
      + "\n"
      + "Zakończ etap, gdy w wymaganym zakresie prąd zmierzony zgadza się z zadanym, "
      + "a praca jest stabilna i bez oscylacji.",
  },

  {
    id: "obs", label: "4 Obserwator",
    find: "Obs:|Pll:",
    mute: EC_MUTE,
    plot: ["Obs:Bias", "Sync:ErrPeak", "Obs:OmegaHat", "Obs:AngleErr", "Obs:OmegaRipple"],
    big: ["Obs:Bias"],
    text:
      "Cel: sprawdzić obserwator, zanim przejmie sterowanie. "
      + "Pozostaw Drive:Mode = if; obserwator pracuje wtedy w tle. "
      + "W planowanym zakresie przejęcia porównuj Obs:OmegaHat z Feedback:RenderFreq. "
      + "Obs:Bias, średnia różnica prędkości obserwatora i rampy, powinien pozostawać blisko zera."
      + "\n"
      + "Zacznij od domyślnych nastaw, jednakowych dla wszystkich wariantów: "
      + "Obs:DtComp 80%, Obs:HpHz 1.6Hz, Pll:Bw 15Hz i Pll:Damp 0.71. "
      + "Na stanowisku Pll:Bw 10, 15 i 20Hz dawały w pętli zamkniętej ten sam wynik. "
      + "Szersze pasmo przenosi tętnienie estymaty na prędkość, którą odczytuje regulator; "
      + "za szerokie Pll:Bw widać w Obs:OmegaRipple jako kilka Hz."
      + "\n"
      + "Obs:DtComp kompensuje w obserwatorze stratę mostka. "
      + "100% oznacza stratę zmierzoną przy ustawianiu wirnika (Obs:DtMeas), "
      + "a bez pomiaru, czyli po starcie przez catch, wartość wynikającą z Pwm:Deadtime. "
      + "Pomiar na silniku 1.5kW dał 1.85–2.09µs wobec nominalnych 2.5µs, "
      + "dlatego mapa ma 80% dla startu przez catch. "
      + "Przy starcie z ustawieniem wirnika wpisz 100%."
      + "\n"
      + "Nastawy obserwatora oceniaj próbami przejęcia "
      + "po przełączeniu Drive:Mode na foc (etap 5), nie odczytami z I/f. "
      + "Słabsza kompensacja obniża Sync:ErrPeak w I/f, "
      + "choć w pętli zamkniętej kompensacja 0 wypadała gorzej niż 100%. "
      + "Różnice Sync:ErrPeak między nastawami bywały mniejsze "
      + "niż między dwoma pomiarami tych samych nastaw."
      + "\n"
      + "Stały Obs:Bias, którego nie usuwa rozsądna kompensacja, "
      + "wskazuje błędne Motor:Ke albo skalę prądu. "
      + "Nie poszerzaj warunków przejęcia, aby ukryć błędną estymację."
      + "\n"
      + "Sync:ErrPeak rośnie z prądem, "
      + "więc samo minimum szczytu wskazuje małą częstotliwość i mały prąd. "
      + "Na stanowisku 1.5kW punkt przejęcia wybrano przy 45Hz "
      + "i taką wartość Foc:EntryFreq ma mapa dla wszystkich wariantów; "
      + "4kW i 7.5kW mają przy niej więcej BEMF."
      + "\n"
      + "Zakończ etap, gdy Obs:OmegaHat stabilnie podąża za Feedback:RenderFreq, "
      + "a Obs:Bias pozostaje blisko zera w całym zakresie przejęcia.",
  },

  {
    id: "sync", label: "5 Przejęcie",
    find: "Foc:Entry|Foc:Lock|Foc:SlipMax|Foc:TakeoverDelta|Sync:",
    mute: EC_MUTE,
    plot: ["Sync:Lock", "Sync:ErrPeak", "Foc:LockErr", "Obs:OmegaHat", "Foc:TakeoverDelta"],
    big: ["Sync:Lock"],
    text:
      "Cel: zapewnić powtarzalne przekazanie sterowania obserwatorowi. "
      + "Przejście z forced do closed wymaga Drive:Mode = foc "
      + "oraz niezerowych Foc:EntryFreq i Foc:LockErr. "
      + "Rampa najpierw dochodzi do Foc:EntryFreq i zatrzymuje się tam do przejęcia, "
      + "także gdy wartość zadana jest niższa. "
      + "Do celu napęd przechodzi dopiero w pętli zamkniętej."
      + "\n"
      + "Sync:Lock zbiera potwierdzenia co 10ms: zgodna próbka dodaje 1, a niezgodna odejmuje 4. "
      + "Próbka jest zgodna, gdy chwilowy błąd kąta mieści się w Foc:LockErr, "
      + "a różnica częstotliwości obserwatora i rampy jest mniejsza "
      + "niż Foc:LockSpeed procent częstotliwości rampy. "
      + "Po osiągnięciu Sync:Lock = " + EC_LOCK_FULL + " przejęcie następuje, "
      + "gdy błąd kąta spadnie poniżej połowy Foc:LockErr, najwcześniej po 400ms. "
      + "Oceniaj je według Sync:ErrPeak, nie Sync:Err: "
      + "średnia może wyglądać poprawnie mimo chwilowych skoków."
      + "\n"
      + "Foc:LockErr ustaw około 8° powyżej Sync:ErrPeak zmierzonego w punkcie przejęcia; "
      + "mapa ma 60°. "
      + "Foc:LockSpeed pozostaw na 40%. "
      + "Jeżeli Sync:Lock nie dochodzi do końca, choć Sync:ErrPeak jest mniejszy niż Foc:LockErr, "
      + "najpierw poszerz Foc:LockSpeed, a dopiero potem Foc:LockErr. "
      + "Nie rozszerzaj tolerancji wyłącznie po to, aby wymusić przejście."
      + "\n"
      + "Stan B: w punkcie przejęcia estymata pozostaje za polem dalej, niż pozwala obciążenie, "
      + "a Obs:AngleErr pokazuje ponad 105° opóźnienia. "
      + "Napęd nie przejmuje sterowania, "
      + "po 0.5s przechodzi w wybieg bez błędu i startuje ponownie. "
      + "Czwarty rozbieg z rzędu przejmuje sterowanie mimo stanu B. "
      + "Na stanowisku stan B występował głównie po starcie na obracającym się wirniku."
      + "\n"
      + "Foc:TakeoverDelta to kąt, o który przejęcie obraca układ współrzędnych: "
      + "z kąta wymuszonego na kąt obserwatora. "
      + "Na stanowisku pętle trwałe miały 61–97°, "
      + "a tracone po kilkudziesięciu milisekundach 119–150°. "
      + "Przy dużym kącie pomaga większy prąd w punkcie przejęcia (tabela Curr), "
      + "a nie większa tolerancja przejęcia."
      + "\n"
      + "Foc:EntryTimeout ogranicza oczekiwanie po dojściu do Foc:EntryFreq; "
      + "po jego upływie napęd zgłasza błąd sync i nie kontynuuje pracy w I/f. "
      + "Zero oznacza oczekiwanie bez ograniczenia."
      + "\n"
      + "Z pętli zamkniętej nie ma powrotu do I/f: "
      + "utrata pętli kończy się błędem sync i wybiegiem. "
      + "Sync:ExitCause podaje przyczynę: " + EC_EXIT_LIST + ". "
      + "Sync:ExitTime podaje czas trwania pętli, a Sync:Takeovers liczy przejęcia."
      + "\n"
      + "Zakończ etap, gdy kolejne starty przejmują sterowanie za pierwszym razem, "
      + "bez błędu sync i bez skoków prądu.",
  },

  {
    id: "foc", label: "6 FOC",
    find: "Foc:Curr|Foc:Iq|Foc:Mod|Foc:Weak|Foc:Flags|SpeedCtrl:|Speed:Derate|Speed:Max"
      + "|Freeze:State|Freeze:Hold",
    mute: EC_MUTE,
    plot: [
      "Foc:IqCmd", "Estim:Id", "Obs:OmegaHat", "Feedback:ModIndex",
      "Obs:Bias", "Meas:CurrAvg", "Freeze:State",
    ],
    big: ["Foc:IqCmd"],
    text:
      "Cel: dostroić pętlę zamkniętą i sprawdzić górę zakresu. "
      + "Przy Drive:Stage = closed kąt elektryczny wyznacza obserwator, "
      + "a regulator prędkości zadaje prąd osi q. "
      + "Foc:IqMax ogranicza cały prąd: "
      + "osłabianie pola zajmuje oś d, a regulator prędkości resztę. "
      + "Regulator nie wytwarza momentu hamującego: wentylator zwalnia pod własnym obciążeniem."
      + "\n"
      + "Foc:CurrBw ustala pasmo pętli prądu, "
      + "a jej nastawy wynikają z Motor:Rs oraz z Motor:Lq dla osi q i Motor:Ld dla osi d. "
      + "Pozostaw wartość domyślną, chyba że odpowiedź prądu jest za wolna albo zaczyna falować. "
      + "Poniżej osłabiania pola Foc:IqCmd i MeasCtrl:CurrAvg powinny się pokrywać."
      + "\n"
      + "Pętlę prędkości strój na końcu, zmieniając po jednym parametrze. "
      + "SpeedCtrl:Kp ustala szybkość reakcji, a SpeedCtrl:Ki usuwa uchyb ustalony. "
      + "W pętli zamkniętej Obs:Bias pokazuje uchyb regulatora prędkości. "
      + "Mapa 1.5kW ma SpeedCtrl:Kp = 150; przy 75 rozrzut Obs:Bias na stanowisku był większy. "
      + "Jeżeli prędkość zaczyna falować, cofnij ostatnią zmianę."
      + "\n"
      + "Prąd wentylatora rośnie w przybliżeniu z kwadratem prędkości, a moc z sześcianem. "
      + "Na stanowisku 1.5kW prąd momentu wynosił "
      + "0.47A przy 40Hz, 1.02A przy 80Hz i 1.54A przy 100Hz. "
      + "Od Speed:DerateCurr, porównywanego z Meas:CurrAvg, "
      + "napęd liniowo obniża limit prędkości w stronę Speed:DerateLimit "
      + "i osiąga go przy Thresh:CurrRms. "
      + "Tak samo działa Speed:DerateTemp dla temperatury. "
      + "To ograniczenie bez błędu: napęd przestaje przyspieszać."
      + "\n"
      + "Sufit wektora napięcia ustala Foc:ModCeil, najwyżej do granicy liniowej SVPWM 115.47%. "
      + "Pwm:Deadtime i Pwm:MinPulse obniżają go: "
      + "przy 2500ns sufit wynosi 105.2%, więc wyższe Foc:ModCeil nic już nie daje."
      + "\n"
      + "Gdy napięcie pętli przekracza Foc:WeakCeil (fabrycznie 95%) okręgu Foc:ModCeil, "
      + "napęd osłabia pole: prowadzi prąd osi d poniżej zera, co pokazuje Estim:Id, "
      + "dzięki czemu wirnik osiąga prędkości większe niż granica samego okręgu napięcia. "
      + "Foc:WeakTime (fabrycznie 100ms) to stała czasowa osłabiania: "
      + "krótsza reaguje szybciej, ale może wprowadzać kołysanie. "
      + "Przy osłabianiu szczyt BEMF może przekroczyć napięcie szyny DC, "
      + "dlatego gdy szczyt wyznaczony z Motor:Ke dochodzi do 30V pod Thresh:DcBusMax, "
      + "napęd odcina mostek z błędem bemf. "
      + "Speed:Max ustawia się poniżej tej prędkości."
      + "\n"
      + "Gdy wektor mimo to dochodzi do sufitu, Foc:Flags pokazuje sat, "
      + "a rampa zatrzymuje się z Freeze:State = hold, "
      + "zamiast oddalać się od wirnika i dociskać regulator do Foc:IqMax. "
      + "Freeze:HoldCount liczy takie wstrzymania. "
      + "Foc:Flags podtrzymuje przez około 2s także flagę limit, czyli osiągnięcie Foc:IqMax."
      + "\n"
      + "Na stanowisku 1.5kW napęd osiągnął 190Hz przy 3.6A i mocy pozornej około 1.3kVA, "
      + "ograniczany przez Speed:DerateCurr. "
      + "Szczyty prądu sięgały tam 7.0A, tuż pod progiem wyłączenia, "
      + "bo tętnienie prądu jest poza pasmem pętli prądu. "
      + "Nie podnoś więc Speed:DerateCurr ani progów prądu, aby uzyskać wyższą prędkość."
      + "\n"
      + "Zakończ etap, gdy odpowiedź na zmianę wartości zadanej jest szybka i bez oscylacji, "
      + "a flagi limit i sat pojawiają się tylko na górze zakresu.",
  },

  {
    id: "rampy", label: "7 Rampy",
    table: "Rise",
    find: "Rise:|Fall:|Brake:|Freeze:Vdc|Bus:Max|Estim:Freq",
    mute: EC_MUTE,
    plot: ["MeasCtrl:DcBus", "Thresh:DcBusMax", "Freeze:VdcHigh", "Freeze:VdcLow"],
    big: ["MeasCtrl:DcBus"],
    text:
      "Cel: dobrać tempo rozpędzania i zwalniania oraz zatrzymanie. "
      + "Tabela Rise ustala tempo rozpędzania, a Fall zwalniania, "
      + "obie w Hz/s w 14 punktach od 0Hz do 300Hz; "
      + "tempo jest odczytywane przy bieżącej częstotliwości. "
      + "Najpierw ustaw Rise, potem Fall. "
      + "Po zmianie punktu powtarzaj ten sam cykl, aby porównać wyniki."
      + "\n"
      + "Przy rozpędzaniu obserwuj MeasCtrl:CurrAvg i flagę limit w Foc:Flags. "
      + "Szyna DC opada pod obciążeniem, na stanowisku 1.5kW o około 4.7V na każde 100W. "
      + "Freeze:VdcLow wstrzymuje przyspieszanie, gdy szyna spadnie poniżej progu, "
      + "więc musi być niższy od napięcia szyny w najwyższym punkcie pracy; "
      + "mapa ma 430V, 10V powyżej Thresh:DcBusMin."
      + "\n"
      + "W pętli zamkniętej regulator nie hamuje, "
      + "więc tabela Fall szybsza od naturalnego zwalniania wentylatora "
      + "nie przyspiesza zwalniania, a wirnik pozostaje szybszy od rampy. "
      + "Gdy rampa dojdzie do wartości zadanej przy wirniku szybszym o więcej niż Foc:SlipMax, "
      + "pętla kończy się błędem sync z przyczyną slip. "
      + "Wentylator 1.5kW bez napędu zwalnia o około 2.8Hz/s przy 40Hz i 3.4Hz/s przy 50Hz; "
      + "tabela Fall powinna pozostać poniżej tych wartości."
      + "\n"
      + "W V/f i I/f zwalnianie oddaje energię wirnika do szyny DC, "
      + "bo prostownik diodowy nie oddaje jej do sieci. "
      + "Freeze:VdcHigh wstrzymuje wtedy zwalnianie, a Freeze:State pokazuje hv+. "
      + "Częste wstrzymania oznaczają zbyt szybką tabelę Fall. "
      + "Freeze:VdcHigh wynosi najwyżej Thresh:DcBusMax − 50V; "
      + "jeżeli błąd hv+ pojawia się przed wstrzymaniem rampy, obniż go. "
      + "Thresh:DcBusMax to próg błędu; nie podnoś go, aby skompensować zbyt szybkie zwalnianie."
      + "\n"
      + "Ctrl:Setpoint = 0 sprowadza napęd tabelą Fall do progu trybu, "
      + "Brake:CutoffVf, Brake:CutoffIf albo Brake:CutoffFoc, i tam odcina mostek, "
      + "a Ctrl:Mode = off odcina go od razu. "
      + "Po odcięciu silnik wybiega. "
      + "Brake:Coast to czas wybiegu przy 50Hz, "
      + "z innej częstotliwości przeliczany przez pierwiastek z jej stosunku do 50Hz, "
      + "a kolejny rozruch napęd przyjmuje po Brake:Wait procent tego czasu."
      + "\n"
      + "Przed każdym rozruchem napęd sprawdza obroty krótkim impulsem na dolnych tranzystorach, "
      + "a wynik podaje Estim:Freq. "
      + "Lekko obracający się wirnik zatrzymuje zwarciem i rusza, "
      + "a przy mocno obracającym się czeka w wybiegu i sprawdza co sekundę. "
      + "Brake:ShortCurr ogranicza prąd impulsu i hamowania zwarciem, "
      + "najwyżej do Thresh:CurrPeak, a 0 wyłącza sprawdzenie. "
      + "Czekanie dłuższe niż Brake:WaitMax procent wybiegu kończy się błędem rpm."
      + "\n"
      + "Bus:Max pokazuje najwyższe napięcie szyny od startu."
      + "\n"
      + "Zakończ etap, gdy pełne cykle rozpędzania i zwalniania przebiegają "
      + "bez błędów i częstych wstrzymań rampy.",
  },

  {
    id: "bledy", label: "8 Błędy silnika",
    find: "Fault:|Thresh:Curr|Thresh:Peak|Thresh:Stall|Thresh:Spin|Brake:|Estim:Freq",
    mute: EC_MUTE,
    plot: ["Fault:Code", "Fault:PeakEvents"], big: [],
    text:
      "Cel: rozpoznać błąd prądu albo wirnika z Fault:Code. "
      + "Fault:Freq i Fault:Curr przechowują wartości z chwili błędu."
      + ecFaultLines("bledy")
      + "\n"
      + "Nie podnoś progów, aby błąd zniknął. "
      + "Kasowanie i ponawianie startu opisuje etap 9.",
  },

  {
    id: "naped", label: "9 Błędy napędu",
    find: "Fault:|Thresh:DcBus|Thresh:Ripple|Thresh:Flyback|Thresh:Temp|Bus:Max|Meas:Flyback"
      + "|MeasCtrl:Ripple|Speed:Max|Motor:Ke",
    mute: EC_MUTE,
    plot: ["Fault:Code", "MeasCtrl:DcBus", "Bus:Max", "Meas:Flyback"], big: [],
    text:
      "Cel: rozpoznać błąd zasilania, temperatury albo sprzętu napędu. "
      + "Fault:Vdc i Fault:Temp przechowują wartości z chwili błędu."
      + ecFaultLines("naped")
      + "\n"
      + "Tętnienie szyny DC ponad Thresh:Ripple blokuje rozruch bez zgłaszania błędu; "
      + "MeasCtrl:Ripple podaje jego wartość."
      + "\n"
      + "Fault:Clear kasuje każdy błąd, także silnika; jeśli przyczyna trwa, błąd wróci. "
      + "Napęd sam ponawia start najwyżej Fault:RetryCount razy, "
      + "a każdy rozruch po błędzie następuje po Brake:Wait czasu wybiegu "
      + "i po sprawdzeniu obrotów wirnika.",
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
