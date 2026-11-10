// scripts/widgets/ectra-guide.jsx

// The PMSM guide: the basic settings of the drive by topic, and what limits it right now.
// Prose only, because every knob it could offer is a knob the grid already has:
// one control in two places is one control too many.
//
// What it does instead is aim the rest of the app.
// Picking a topic highlights its registers, charts what goes with them
// and drops the groups that take no part in it out of the poll cycle.
// That is the part the app cannot do on its own:
// it holds no opinion about any device, and this file is nothing but an opinion about one.
// Above the prose, a few sentences say what holds the drive back right now,
// read off the registers they name.
//
// The prose names registers and quotes no defaults and no measured values:
// values and ranges are the map's, and the whole story is the PMSM documents'.
// So the text changes when the firmware changes what a register means,
// not every time a default moves.
//
// The tables are `EctraTables`.
// A table is a shape the grid cannot draw, so it earns its own panel;
// this one earns a column beside the grid,
// because its text and the rows it points at have to be readable together.

const EC_TOPIC_KEY = "modra.ectra.topic";

// Groups no topic of this guide is about:
// a log, counters, the identity of the board, the serial port, the flow table.
// Still readable and writable, they simply stop costing a slot in every cycle,
// so what the topic IS about comes back faster.
// The ones the config file carries still arrive with every full sync.
//
// `Flow` and `Journal` alone are more than half the registers,
// and no other group comes close.
// That is the whole argument for where this list ends:
// past these, muting buys almost nothing and risks hiding a reading that turns out to matter.
const EC_DEAD = ["Flow:*", "Journal:*", "Counter:*", "Version:*", "System:*", "RS485:*"];

// The other sources of the setpoint and the resonance bands each belong to one topic
const EC_IO = ["Digital:*", "AnalogInput:*", "Failsafe:*"];
const EC_MUTE = EC_DEAD.concat(EC_IO, "Resonance:*");

// A register name in prose: what `ecNamed` collects and `Para` turns into a link
const EC_NAME = "[A-Z][A-Za-z]*:[A-Za-z0-9]+";

// Every register a topic names in its own prose.
// The topic talks about it, so the topic has to keep it arriving:
// a sentence pointing at a row frozen at its last value is worse than no sentence.
// Derived from the text rather than listed beside it,
// because a list beside it is a list that goes stale.
const ecNamed = (text) => text.match(new RegExp(EC_NAME, "g")) || [];

// Lit in the grid at every topic.
// How the drive is commanded, what it made of that, and how a fault is cleared
// belong to no single topic: they are how you start, stop and recover under each of them,
// and a topic that hid them would leave no way back.
//
// `Drive:Stage` earns its place twice over.
// `Drive:Mode` is what you asked for and `Drive:Stage` is what the drive did with it,
// and the two disagree exactly when something is wrong:
// missing motor constants drop a vector run to `obs`, a bad current channel to `guard`.
// Reading the request without the answer
// is how an hour goes into a mode that never engaged.
const EC_FIND_ALWAYS =
  "Ctrl:Mode|Ctrl:Setpoint|Drive:Mode|Drive:Stage|Fault:Code|Fault:Clear";

// Charted at every topic: what the drive was asked for, what it rendered,
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
// A topic adds the reading it is about.
const EC_BIG = ["Feedback:RenderFreq"];

//---------------------------------------------------------------------------------------- Verdicts

// What each `Sync:ExitCause` means, worded to follow "<cause>, gdy".
// The motor faults topic lists them and the live note names the one standing.
const EC_EXIT = {
  slip: "prędkość obserwatora przekroczyła częstotliwość rampy o więcej niż Foc:SlipMax "
    + "albo spadła poniżej jej połowy",
  unlock: "średni błąd kąta z ostatniego obrotu był za duży",
  weak: "średni strumień aktywny z ostatniego obrotu zanikł",
  config: "zmiana nastaw wyłączyła obserwator",
};

// Every cause in one sentence, as the motor faults topic lists them
const EC_EXIT_LIST = Object.entries(EC_EXIT)
  .map(([cause, means]) => `${cause}, gdy ${means}`)
  .join("; ");

// Every `Fault:Code`, what tripped it and the first thing to check, in code order.
// Each is listed on its `topic` in this order, and the live note quotes the one that is active.
// A text opens with a plain word, which the list lower-cases after the code and its colon.
// `feed` closes the list: it is a journal event and never shows in `Fault:Code`.
const EC_FAULTS = [
  {
    codes: ["peak"], topic: "bledy",
    text:
      "Sprzętowe zabezpieczenie nadprądowe zadziałało Thresh:PeakCount razy; "
      + "zadziałania liczy Fault:PeakEvents. "
      + "Prąd w punkcie pracy jest za duży: "
      + "w V/f napięcie z tabeli Volt odbiega od minimum prądu, "
      + "w I/f za duży jest prąd z tabeli Curr, a w FOC Foc:IqMax. "
      + "Przyczyną może być też za duże obciążenie.",
  },
  {
    codes: ["imax"], topic: "bledy",
    text:
      "Amplituda prądu fazy (połowa MeasCtrl:PeakMax) przekraczała Thresh:CurrPeak przez 1s. "
      + "W V/f należy sprawdzić tabelę Volt, a w I/f tabelę Curr; "
      + "w FOC prąd zależy od obciążenia, a ogranicza go Foc:IqMax.",
  },
  {
    codes: ["irms"], topic: "bledy",
    text:
      "Prąd MeasCtrl:CurrAvg przekraczał Thresh:CurrRms przez 1s. "
      + "W V/f należy sprawdzić tabelę Volt, a w I/f tabelę Curr; "
      + "w FOC Foc:IqMax większy od Thresh:CurrRms pozwala regulatorowi przekroczyć próg błędu.",
  },
  {
    codes: ["stall"], topic: "bledy",
    text:
      "Podczas rozpędzania z tabelą V/f, przez Thresh:StallTime, "
      + "prąd przekraczał Thresh:StallCurr poniżej Thresh:StallFreq "
      + "albo wirnik stał pod wirującym polem. "
      + "Fault:Freq poniżej 10Hz oznacza za duży prąd: "
      + "należy zmniejszyć punkty od Volt:0Hz do Volt:10Hz. "
      + "Fault:Freq od Thresh:StallFreq w górę oznacza stojący wirnik: "
      + "należy zwiększyć Volt:0Hz, zwolnić rampę w tabeli Rise albo wydłużyć Drive:AlignTime.",
  },
  {
    codes: ["spin"], topic: "bledy",
    text:
      "Wirnik nie nadąża za polem w etapie forced. "
      + "Prędkość obserwatora przez 2s była mniejsza od połowy częstotliwości rampy "
      + "albo od 40Hz moc czynna nie wzrosła w czasie Thresh:SpinTime "
      + "o Thresh:SpinPower ponad poziom z 15Hz. "
      + "Należy zwiększyć prąd w tabeli Curr w tym zakresie albo zwolnić rampę w tabeli Rise. "
      + "Silnik bez wentylatora może nie dać takiego przyrostu mocy; "
      + "Thresh:SpinPower = 0 wyłącza to kryterium.",
  },
  {
    codes: ["sync"], topic: "bledy",
    text:
      "Napęd stracił zamkniętą pętlę FOC, wykrył w niej brak fazy "
      + "albo nie przejął sterowania w czasie Foc:EntryTimeout. "
      + "Przyczynę utraty pętli podaje Sync:ExitCause.",
  },
  {
    codes: ["rpm"], topic: "bledy",
    text:
      "Przed rozruchem wirnik obracał się za szybko, by go zahamować zwarciem, "
      + "dłużej niż Brake:WaitMax czasu wybiegu; "
      + "obroty z ostatniego sprawdzenia podaje Estim:Freq. "
      + "Wirnik może napędzać przeciąg albo drugi wentylator w kanale. "
      + "Na dłuższy wybieg pozwala większy Brake:Coast albo Brake:WaitMax, "
      + "a na hamowanie zwarciem od wyższych obrotów większy Brake:ShortCurr, "
      + "najwyżej równy Thresh:CurrPeak.",
  },
  {
    codes: ["temp"], topic: "naped",
    text:
      "Temperatura stopnia mocy MeasCtrl:Temp przekraczała Thresh:Temp przez 1s. "
      + "Należy sprawdzić chłodzenie napędu.",
  },
  {
    codes: ["hv-"], topic: "naped",
    text:
      "Napięcie szyny DC MeasCtrl:DcBus było niższe od Thresh:DcBusMin przez 1s. "
      + "Należy sprawdzić napięcie zasilania.",
  },
  {
    codes: ["hv+"], topic: "naped",
    text:
      "Napięcie szyny DC MeasCtrl:DcBus przekraczało Thresh:DcBusMax przez 1s "
      + "albo przekroczyło próg szybkiej ochrony szyny, o 30V niższy. "
      + "Przy zwalnianiu w V/f i I/f pomaga niższy Freeze:VdcHigh albo wolniejsza tabela Fall. "
      + "Szybki wzrost do progu ochrony oznacza energię spoza rampy, "
      + "na przykład od wirnika, który wypadł z synchronizmu.",
  },
  {
    codes: ["bemf"], topic: "naped",
    text:
      "W zamkniętej pętli FOC szczyt BEMF wyznaczony z Motor:Ke "
      + "doszedł do progu szybkiej ochrony szyny, 30V poniżej Thresh:DcBusMax. "
      + "Należy obniżyć Speed:Max poniżej prędkości, przy której to nastąpiło, "
      + "albo sprawdzić Motor:Ke, bo zawyżona wartość obniża tę granicę.",
  },
  {
    codes: ["lv-", "lv+"], topic: "naped",
    text:
      "Napięcie zasilacza pomocniczego MeasCtrl:Flyback było przez 1s poza zakresem "
      + "od Thresh:FlybackMin do Thresh:FlybackMax.",
  },
  {
    codes: ["link"], topic: "naped",
    text:
      "Procesor sig przez 1.5s nie dostał poprawnej ramki łącza wewnętrznego. "
      + "Błąd znika, gdy łącze wróci, "
      + "a częste błędy, zliczane w Counter:Link, wskazują na usterkę sprzętu.",
  },
  {
    codes: ["feed"], topic: "naped",
    text:
      "Zdarzenie trafia tylko do dziennika, nie do Fault:Code. "
      + "Kontrola toru pomiaru prądu przełączyła napęd na tabelę V/f bez zatrzymania silnika, "
      + "a Drive:Stage wskazuje guard.",
  },
];

// The faults one topic lists, a paragraph each
function ecFaultLines(topic) {
  return EC_FAULTS
    .filter(f => f.topic === topic)
    .map(f => "\n" + f.codes.join(" i ") + ": " + f.text[0].toLowerCase() + f.text.slice(1))
    .join("");
}

// `Drive:Stage` values that say why the V/f table drives the bridge in `if` or `foc`.
// `off` is missing: it answers `Drive:Mode = vf`, which is no news.
const EC_WHY = {
  shunt: "Drive:Stage = shunt: tor pomiaru prądu nie ma skali "
    + "(Sense:ShuntRes, Sense:ShuntGain), więc mostkiem steruje tabela V/f.",
  obs: "Drive:Stage = obs: obserwator nie jest gotowy, więc mostkiem steruje tabela V/f. "
    + "Należy sprawdzić Motor:Rs, Motor:Lq i Motor:Ke.",
  volts: "Drive:Stage = volts: Foc:ModCeil jest za niski, "
    + "by sprawdzić tor pomiaru prądu przed rozruchem, więc mostkiem steruje tabela V/f.",
  guard: "Drive:Stage = guard: kontrola toru pomiaru prądu przed sterowaniem wektorowym "
    + "nie powiodła się, więc mostkiem steruje tabela V/f. "
    + "Należy sprawdzić przewody i ciągłość kanałów pomiaru prądu.",
};

// What each `Freeze:State` means, as the live note says it
const EC_FREEZE = {
  "hv-": "Rampa nie przyspiesza: napięcie szyny DC jest niższe od Freeze:VdcLow.",
  "hv+": "Rampa nie zwalnia: napięcie szyny DC przekracza Freeze:VdcHigh.",
  hold: "Rampa nie przyspiesza: wektor napięcia jest na ograniczeniu Foc:ModCeil, "
    + "które obniżają też Pwm:Deadtime i Pwm:MinPulse. "
    + "Freeze:HoldCount liczy takie wstrzymania.",
  lim: "Rampa czeka na wirnik: regulator prędkości doszedł do Foc:IqMax.",
};

// `Sync:Lock` at which the takeover arms
const EC_LOCK_FULL = 40;
// How close to `Foc:EntryFreq` the ramp counts as standing on it
const EC_ENTRY_TOL_Hz = 0.1;

// Everything the live note reads, kept arriving while a topic mutes the rest
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
      + "Rozruch będzie możliwy po upływie części wybiegu ustawionej w Brake:Wait "
      + "i po sprawdzeniu obrotów wirnika; wynik sprawdzenia podaje Estim:Freq.");
  }
  const mode = v("Drive:Mode");
  const stage = v("Drive:Stage");
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
    line += lock == null ? "." : `: Sync:Lock wynosi ${lock} z ${EC_LOCK_FULL}.`;
    if(peak != null && gate > 0 && peak >= gate) line += " Sync:ErrPeak przekracza Foc:LockErr.";
    out.push(line);
  }
  else if(EC_FREEZE[v("Freeze:State")]) out.push(EC_FREEZE[v("Freeze:State")]);
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

//------------------------------------------------------------------------------------------ Topics

// `\n` starts a paragraph.
// `find` is a strict search query, `|` joining alternatives,
// so a topic leaves exactly its own registers lit in the grid.
// `table` is the one the tables panel is asked to open, where a topic is about one.
const EC_INTRO =
  "Przewodnik opisuje podstawowe nastawy napędu PMSM, jego ograniczenia i błędy. "
  + "Wybór tematu wyróżnia jego rejestry w siatce, ustawia wykresy "
  + "i pomija w cyklicznym odczycie grupy, których temat nie dotyczy. "
  + "Ponowne kliknięcie aktywnego tematu przywraca wcześniejszy widok."
  + "\n"
  + "Ramka nad tekstem pokazuje na bieżąco, co ogranicza napęd: aktywny błąd, wybieg, "
  + "praca z tabelą V/f zamiast sterowania wektorowego, wstrzymanie rampy, "
  + "oczekiwanie na przejęcie albo ograniczenie prędkości."
  + "\n"
  + "Nazwy rejestrów są odnośnikami: najechanie kursorem zaznacza wiersz w siatce, "
  + "a kliknięcie przenosi do niego."
  + "\n"
  + "Zakresy i wartości fabryczne podaje mapa rejestrów, "
  + "a pełny opis napędu dokumenty od PMSM-001 do PMSM-008.";

const EC_TOPICS = [

  {
    id: "silnik", label: "Silnik i pomiar",
    find: "Motor:|Sense:Shunt|Trim:Curr|Meas:Speed|Meas:CurrAvg|MeasCtrl:CurrAvg|Estim:Freq"
      + "|Auth:Access",
    mute: EC_MUTE,
    plot: ["Meas:Speed", "Estim:Freq"], big: [],
    text:
      "Sterowanie I/f i FOC opiera się na danych silnika. "
      + "Bez Motor:Rs i Motor:Lq napęd pracuje tylko z tabelą V/f, "
      + "a bez Motor:Ke nie przechodzi do FOC; przyczynę podaje Drive:Stage. "
      + "Parametry silnika i toru pomiaru zapisuje się z poziomem dostępu admin, "
      + "a Drive:Mode i Motor:Invert z poziomem service; bieżący poziom podaje Auth:Access."
      + "\n"
      + "Motor:Type to wariant napędu, dla którego zbudowano firmware; "
      + "jego zmiana nie wczytuje nastaw innego wariantu. "
      + "Motor:Rotor to średnica wirnika wentylatora. "
      + "Napęd jej nie używa; służy do porównywania zapisów z instalacji z tym samym wirnikiem."
      + "\n"
      + "Motor:PolePairs przepisuje się z karty silnika. "
      + "Motor:Rs to połowa rezystancji zmierzonej omomierzem między dwoma zaciskami, "
      + "razem z kablem silnika. "
      + "Motor:Ld i Motor:Lq to połowa najmniejszego i największego wskazania miernika LCR "
      + "między dwoma zaciskami przy obracaniu wału. "
      + "Motor:Ke to skuteczne napięcie międzyfazowe na zaciskach odłączonego silnika "
      + "obracanego z zewnątrz, przeliczone na 1000rpm."
      + "\n"
      + "Sense:ShuntRes, Sense:ShuntGain i Sense:ShuntTau to dane płytki: rezystancja bocznika, "
      + "wzmocnienie wzmacniacza i stała czasowa jego sprzężenia zwrotnego. "
      + "Napęd wykrywa tylko brak skali; przy błędnej wartości "
      + "prąd rzeczywisty różni się od tabeli Curr, progów prądu i odczytów. "
      + "MeasCtrl:CurrAvg i Meas:CurrAvg to skuteczny prąd fazy, "
      + "taki jak wskazanie miernika cęgowego; niewielką różnicę koryguje Trim:CurrScale."
      + "\n"
      + "Meas:Speed to prędkość wału wyznaczona z częstotliwości i Motor:PolePairs, "
      + "więc rozbieżność ze wskazaniem tachometru oznacza błędną liczbę par biegunów. "
      + "Estim:Freq to częstotliwość obrotu wektora prądu, niezależna od wartości zadanej: "
      + "w V/f pokazuje w przybliżeniu ruch wirnika, "
      + "a przed rozruchem wynik sprawdzenia obrotów. "
      + "Motor:Invert zmienia kierunek obrotów od następnego rozruchu."
      + "\n"
      + "Pomiar parametrów silnika opisuje dokument \"Pierwsze uruchomienie\" (PMSM-003), "
      + "a tory pomiarowe \"Modulacja PWM i pomiary\" (PMSM-005).",
  },

  {
    id: "sterowanie", label: "Sterowanie",
    find: "Feedback:|AnalogInput:|Digital:InputMode|Failsafe:",
    mute: EC_DEAD.concat("Resonance:*"),
    plot: ["Feedback:State"], big: [],
    text:
      "Ctrl:Mode wybiera źródło i jednostkę wartości zadanej Ctrl:Setpoint. "
      + "Tryb off wyłącza mostek, ai oznacza wejście analogowe, "
      + "% procent zakresu od Speed:Min do Speed:Max, "
      + "rpm prędkość obrotową, a Hz częstotliwość elektryczną."
      + "\n"
      + "Wartość zadana 0 albo mniejsza od Speed:Min zatrzymuje silnik rampą. "
      + "Zmiana Ctrl:Mode od razu wyłącza mostek i zeruje Ctrl:Setpoint, a silnik wybiega, "
      + "dlatego wartość zadaną wpisuje się po wyborze trybu; "
      + "ponowny zapis tego samego trybu nic nie zmienia."
      + "\n"
      + "Drive:Mode wybiera metodę sterowania: vf to sterowanie skalarne według tabeli Volt, "
      + "if to prąd z tabeli Curr przy kącie wymuszonym przez rampę, "
      + "a foc to praca w zamkniętej pętli FOC po przejęciu kąta przez obserwator. "
      + "Zmiana działa od razu, bez zatrzymania silnika, "
      + "a w zamkniętej pętli FOC od następnego rozruchu."
      + "\n"
      + "Drive:Stage podaje etap, w którym napęd rzeczywiście pracuje: "
      + "align, catch, forced albo closed. "
      + "Gdy sterowanie wektorowe nie jest możliwe, mostkiem steruje tabela V/f, "
      + "a Drive:Stage podaje przyczynę: shunt, obs, guard, volts albo fault."
      + "\n"
      + "Feedback:SetpointFreq to częstotliwość zadana po przeliczeniu, "
      + "ominięciu pasm rezonansu i ograniczeniu do zakresu prędkości, "
      + "a Feedback:RenderFreq to częstotliwość na wyjściu rampy. "
      + "Różnica między nimi oznacza, że rampa jeszcze nie doszła do wartości zadanej, "
      + "jest wstrzymana, trwa rozruch albo działa ograniczenie prędkości."
      + "\n"
      + "W trybie ai przy AnalogInput:Mode = speed napięcie wejścia wyznacza wartość zadaną: "
      + "poniżej AnalogInput:Stop silnik się zatrzymuje, "
      + "a od AnalogInput:Min do AnalogInput:Max prędkość rośnie liniowo "
      + "od Speed:Min do Speed:Max. "
      + "Wejście cyfrowe ustawione w Digital:InputMode jako zezwolenie na pracę, "
      + "allow-high albo allow-low, zatrzymuje silnik rampą, gdy nie jest aktywne. "
      + "Po utracie komunikacji RS-485 na dłużej niż Failsafe:Delay "
      + "wartość zadaną wyznaczają Failsafe:Mode i Failsafe:Setpoint."
      + "\n"
      + "Szczegóły podaje dokument \"Rampa i szyna DC\" (PMSM-006).",
  },

  {
    id: "rozruch", label: "Rozruch i zatrzymanie",
    find: "Brake:|If:CatchFreq|Drive:InitFreq|Drive:AlignTime|Foc:EntryFreq|Foc:EntryTimeout"
      + "|Sync:Lock|Estim:Freq|Feedback:State|Obs:DtMeas",
    mute: EC_MUTE,
    plot: ["Feedback:State", "Estim:Freq", "Sync:Lock"], big: [],
    text:
      "Przed każdym rozruchem napęd sprawdza, czy wirnik się obraca: "
      + "na kilka okresów PWM zwiera dolne tranzystory "
      + "i z przyrostu prądu zwarcia wyznacza prędkość wirnika, którą podaje Estim:Freq. "
      + "Gdy wirnik obraca się wolno, napęd hamuje go zwarciem i rusza; "
      + "gdy szybko, czeka w wybiegu i co sekundę sprawdza obroty ponownie."
      + "\n"
      + "Brake:ShortCurr ogranicza amplitudę prądu zwarcia przy sprawdzaniu obrotów i hamowaniu, "
      + "najwyżej do Thresh:CurrPeak; 0 wyłącza sprawdzenie. "
      + "Gdy w czasie Brake:WaitMax wybiegu wirnik nie zwolni na tyle, by go zahamować zwarciem, "
      + "napęd zgłasza błąd rpm."
      + "\n"
      + "If:CatchFreq wybiera sposób rozruchu w trybach if i foc. "
      + "Wartość 0 to ustawienie wirnika prądem Curr:0Hz przez Drive:AlignTime "
      + "i pomiar czasu martwego, którego wynik podaje Obs:DtMeas. "
      + "Wartość dodatnia to rozruch z tabelą Volt do tej częstotliwości, "
      + "po którym sterowanie przejmują regulatory prądu. "
      + "Rampa zaczyna się od Drive:InitFreq."
      + "\n"
      + "W trybie foc rampa dochodzi do Foc:EntryFreq i zostaje na tej częstotliwości "
      + "do przejęcia kąta przez obserwator, także gdy wartość zadana jest mniejsza. "
      + "Postęp przejęcia pokazuje Sync:Lock. "
      + "Gdy przejęcie nie nastąpi w czasie Foc:EntryTimeout, napęd zgłasza błąd sync; "
      + "0 oznacza czekanie bez ograniczenia."
      + "\n"
      + "Wartość zadana 0 albo mniejsza od Speed:Min sprowadza częstotliwość tabelą Fall "
      + "do progu trybu pracy (Brake:CutoffVf, Brake:CutoffIf albo Brake:CutoffFoc) "
      + "i tam wyłącza mostek. "
      + "Ctrl:Mode = off, zmiana Ctrl:Mode, błąd i utrata łącza wyłączają mostek od razu. "
      + "Po wyłączeniu mostka silnik wybiega, a Feedback:State wskazuje coa."
      + "\n"
      + "Brake:Coast to czas wybiegu z 50Hz; dla innej częstotliwości wyłączenia "
      + "napęd mnoży go przez pierwiastek ze stosunku tej częstotliwości do 50Hz. "
      + "Kolejny rozruch, także po błędzie, jest możliwy po upływie części tego czasu "
      + "ustawionej w Brake:Wait i po sprawdzeniu obrotów wirnika."
      + "\n"
      + "Szczegóły podaje dokument \"Rozruch i zatrzymanie napędu\" (PMSM-002).",
  },

  {
    id: "predkosc", label: "Prędkość i rampa",
    table: "Rise",
    find: "Speed:Min|Speed:Max|Rise:|Fall:|Resonance:|Freeze:Vdc|Freeze:State|MeasCtrl:DcBus"
      + "|Bus:Max",
    mute: EC_DEAD.concat(EC_IO),
    plot: ["MeasCtrl:DcBus", "Freeze:State"], big: ["MeasCtrl:DcBus"],
    text:
      "Speed:Min i Speed:Max wyznaczają zakres prędkości. "
      + "Wartość zadana powyżej Speed:Max jest ograniczana do Speed:Max, "
      + "a poniżej Speed:Min zatrzymuje silnik rampą. "
      + "Prędkość obrotową napęd przelicza na częstotliwość elektryczną według Motor:PolePairs."
      + "\n"
      + "Trzy pasma rezonansu, od Resonance:0Low do Resonance:0High i dwa kolejne, "
      + "wyłączają z pracy ustalonej prędkości, "
      + "przy których wentylator albo jego konstrukcja wpada w rezonans. "
      + "Wartość zadana wewnątrz pasma jest przesuwana do bliższej granicy, "
      + "a pasmo, którego granica wynosi zero, jest wyłączone."
      + "\n"
      + "Tabela Rise określa tempo przyspieszania, a tabela Fall tempo zwalniania, "
      + "obie w Hz/s, w 14 punktach od 0Hz do 300Hz. "
      + "Między punktami tempo jest interpolowane liniowo według bieżącej częstotliwości. "
      + "Punkty 0Hz i 2Hz określają tempo tuż po rozruchu "
      + "i tempo dochodzenia do postoju, gdy próg zatrzymania wynosi 0."
      + "\n"
      + "Tabelę Fall dobiera się do naturalnego zwalniania wentylatora. "
      + "W V/f i I/f szybsza rampa wprowadza silnik w pracę prądnicową "
      + "i podnosi napięcie szyny DC. "
      + "W zamkniętej pętli FOC regulator prędkości nie hamuje, "
      + "więc szybsza rampa nie przyspiesza zwalniania. "
      + "Gdy rampa dojdzie do wartości zadanej, a wirnik jest nadal szybszy "
      + "o więcej niż Foc:SlipMax, pętla kończy się błędem sync, a Sync:ExitCause wskazuje slip."
      + "\n"
      + "Napięcie szyny DC poniżej Freeze:VdcLow wstrzymuje przyspieszanie, "
      + "a powyżej Freeze:VdcHigh zwalnianie; przyczynę wstrzymania podaje Freeze:State. "
      + "Częste wstrzymania przy zwalnianiu oznaczają za szybką tabelę Fall. "
      + "Bus:Max podaje najwyższe napięcie szyny od ostatniego rozruchu."
      + "\n"
      + "Szczegóły podaje dokument \"Rampa i szyna DC\" (PMSM-006).",
  },

  {
    id: "ograniczenia", label: "Ograniczenia",
    find: "Speed:Derate|Foc:IqMax|Foc:ModCeil|Foc:Weak|Foc:Flags|Foc:IqCmd|Freeze:State"
      + "|Freeze:HoldCount|Feedback:ModIndex|Feedback:Volt|Estim:Id|Pwm:Deadtime|Pwm:MinPulse"
      + "|Thresh:CurrRms|Thresh:CurrPeak|Thresh:Temp|Meas:CurrAvg|Meas:Temp",
    mute: EC_MUTE,
    plot: ["Foc:IqCmd", "Estim:Id", "Feedback:ModIndex", "Meas:CurrAvg", "Freeze:State"],
    big: ["Foc:IqCmd"],
    text:
      "Przy dużym prądzie albo wysokiej temperaturze napęd zmniejsza prędkość, "
      + "zanim przekroczenie progu błędu wyłączy mostek. "
      + "Od prądu Speed:DerateCurr największa dopuszczalna prędkość maleje liniowo "
      + "i przy Thresh:CurrRms osiąga Speed:DerateLimit; "
      + "tak samo działa Speed:DerateTemp względem Thresh:Temp. "
      + "Ograniczenie korzysta z uśrednionych odczytów Meas:CurrAvg i Meas:Temp "
      + "i nie zgłasza błędu."
      + "\n"
      + "Foc:IqMax ogranicza cały prąd w trybach I/f i FOC. "
      + "Gdy w zamkniętej pętli FOC regulator prędkości dojdzie do Foc:IqMax, "
      + "rampa czeka na wirnik, Freeze:State wskazuje lim, a Foc:Flags flagę limit. "
      + "Większą prędkość daje wtedy większy Foc:IqMax, "
      + "o ile szczyty prądu zostają poniżej Thresh:CurrPeak."
      + "\n"
      + "Foc:ModCeil ogranicza wektor napięcia w sterowaniu wektorowym, "
      + "najwyżej do granicy liniowej SVPWM 115.47%, "
      + "a Pwm:Deadtime i Pwm:MinPulse obniżają tę granicę. "
      + "Gdy wektor zostaje na ograniczeniu, rampa przestaje przyspieszać, "
      + "Freeze:State wskazuje hold, a Foc:Flags flagę sat; "
      + "Freeze:HoldCount liczy takie wstrzymania."
      + "\n"
      + "W zamkniętej pętli FOC, gdy wektor napięcia przekroczy Foc:WeakCeil okręgu Foc:ModCeil, "
      + "napęd osłabia pole: prąd osi d, widoczny w Estim:Id, schodzi poniżej zera, "
      + "a wirnik osiąga prędkości wyższe niż bez osłabiania. "
      + "Foc:WeakTime to stała czasowa osłabiania; "
      + "krótsza reaguje szybciej, ale może wywołać kołysanie."
      + "\n"
      + "Przy osłabianiu pola szczyt BEMF może przekroczyć napięcie szyny DC. "
      + "Gdy szczyt wyznaczony z Motor:Ke dojdzie do progu szybkiej ochrony szyny, "
      + "30V poniżej Thresh:DcBusMax, napęd wyłącza mostek z błędem bemf, "
      + "dlatego Speed:Max ustawia się poniżej tej prędkości."
      + "\n"
      + "Feedback:ModIndex podaje zastosowany stopień modulacji, "
      + "a Feedback:Volt odpowiadające mu napięcie fazowe. "
      + "W FOC odczyt jest w skali V/f, "
      + "więc pełny okrąg Foc:ModCeil przy SVPWM daje odczyt Foc:ModCeil × 0.866."
      + "\n"
      + "Szczegóły podają dokumenty \"Rampa i szyna DC\" (PMSM-006) "
      + "i \"Sterowanie FOC i obserwator\" (PMSM-004).",
  },

  {
    id: "bledy", label: "Błędy silnika",
    find: "Fault:|Thresh:Curr|Thresh:Peak|Thresh:Stall|Thresh:Spin|Brake:|Estim:Freq"
      + "|Sync:ExitCause",
    mute: EC_MUTE,
    plot: ["Fault:Code", "Fault:PeakEvents"], big: [],
    text:
      "Temat obejmuje błędy prądu i utraty kontroli nad wirnikiem. "
      + "Aktywny błąd podaje Fault:Code, "
      + "a Fault:Freq i Fault:Curr zapamiętują częstotliwość i prąd z chwili błędu."
      + ecFaultLines("bledy")
      + "\n"
      + "Sync:ExitCause podaje przyczynę utraty pętli FOC: " + EC_EXIT_LIST + "."
      + "\n"
      + "Kasowanie błędów i automatyczne ponawianie opisuje temat \"Błędy napędu\", "
      + "a objawy i nastawy, które je usuwają, "
      + "dokument \"Strojenie według objawów\" (PMSM-008).",
  },

  {
    id: "naped", label: "Błędy napędu",
    find: "Fault:|Thresh:DcBus|Thresh:Ripple|Thresh:Flyback|Thresh:Temp|Bus:Max|MeasCtrl:Flyback"
      + "|MeasCtrl:Ripple|MeasCtrl:Temp|Counter:Link|Speed:Max|Motor:Ke",
    mute: EC_MUTE,
    plot: ["Fault:Code", "MeasCtrl:DcBus", "Bus:Max", "MeasCtrl:Flyback"], big: [],
    text:
      "Temat obejmuje błędy zasilania, temperatury i sprzętu napędu. "
      + "Fault:Vdc i Fault:Temp zapamiętują napięcie szyny DC i temperaturę z chwili błędu."
      + ecFaultLines("naped")
      + "\n"
      + "Tętnienie szyny DC powyżej Thresh:Ripple blokuje rozruch, ale nie zgłasza błędu; "
      + "jego wartość podaje MeasCtrl:Ripple."
      + "\n"
      + "Zapis 1 do Fault:Clear kasuje aktywny błąd i zeruje licznik ponowień; "
      + "jeżeli przyczyna trwa, błąd wróci. "
      + "Napęd kasuje błędy także sam: po wybiegu odlicza Fault:RetryDelay i kasuje błąd, "
      + "a po Fault:RetryCount ponowieniach kolejny błąd zostaje do ręcznego skasowania. "
      + "Licznik ponowień zeruje się po Fault:RetryTimeout pracy bez błędu, "
      + "a Fault:RetryCount = 0 wyłącza ponawianie. "
      + "Rozruch po błędzie jest możliwy po upływie części wybiegu ustawionej w Brake:Wait "
      + "i po sprawdzeniu obrotów wirnika."
      + "\n"
      + "Szczegóły podaje dokument \"Zabezpieczenia i błędy\" (PMSM-007).",
  },

  {
    id: "strojenie", label: "Strojenie silnika",
    table: "Volt",
    find: "Volt:|Curr:|If:|Obs:|Pll:|Foc:Entry|Foc:Lock|Foc:SlipMax|Foc:CurrBw|SpeedCtrl:"
      + "|MeasCfg:",
    mute: EC_MUTE,
    plot: ["Obs:Bias", "Sync:ErrPeak", "Obs:OmegaHat"], big: ["Obs:Bias"],
    text:
      "Te nastawy dobiera się przy strojeniu silnika danego wariantu, "
      + "a mapa rejestrów podaje je jako wartości fabryczne. "
      + "Na instalacji się ich nie zmienia, chyba że wymaga tego objaw opisany w dokumencie "
      + "\"Strojenie według objawów\" (PMSM-008)."
      + "\n"
      + "Tabela Volt działa tylko przy pracy z tabelą V/f: w trybie vf, "
      + "przy rozruchu do If:CatchFreq i wtedy, gdy sterowanie wektorowe nie jest możliwe. "
      + "Tabela Curr wyznacza prąd w etapie forced, a Curr:0Hz także prąd ustawiania wirnika; "
      + "If:Damp tłumi kołysania wirnika w pracy I/f."
      + "\n"
      + "Rejestry grup Obs i Pll dotyczą obserwatora: "
      + "Obs:DtComp określa kompensowaną część czasu martwego zmierzonego w Obs:DtMeas, "
      + "Obs:HpHz częstotliwość graniczną filtru całkującego, "
      + "a Pll:Bw i Pll:Damp dynamikę pętli PLL."
      + "\n"
      + "Foc:EntryFreq, Foc:LockErr i Foc:LockSpeed określają warunki przejęcia kąta, "
      + "a Foc:SlipMax dopuszczalną różnicę prędkości wirnika i rampy w zamkniętej pętli. "
      + "Foc:CurrBw ustala pasmo regulatorów prądu, "
      + "a SpeedCtrl:Kp i SpeedCtrl:Ki dynamikę regulatora prędkości."
      + "\n"
      + "Rejestry grupy MeasCfg ustawiają filtry pomiarów; ich działanie opisuje dokument "
      + "\"Modulacja PWM i pomiary\" (PMSM-005).",
  },
];

// Every register the guide names, charts or reads, gathered from its own text and lists,
// so the line about a map that lacks some of them cannot fall behind the text
const EC_USES = [...new Set([
  ...EC_TOPICS.flatMap(t => [...ecNamed(t.text), ...t.plot, ...t.big]),
  ...[...Object.values(EC_WHY), ...Object.values(EC_FREEZE)].flatMap(ecNamed),
  ...EC_ALWAYS, ...EC_BIG, ...EC_WATCH, ...EC_FIND_ALWAYS.split("|"),
])];

//------------------------------------------------------------------------------------------- Guide

const Ectra = {

  id: "ectra-guide",
  title: "Ectra · Guide",
  icon: "📖",
  beside: true,

  _topic: null,

  match(regs) {
    return ["Obs:DtComp", "Sync:Lock", "Drive:Stage"]
      .every(n => regs.some(r => r.name === n));
  },

  // Picking a topic aims the whole app at it;
  // dropping it hands the operator their own view back, filter, charts and ignore list alike.
  pick(id) {
    this._topic = id === this._topic ? null : id;
    const topic = EC_TOPICS.find(t => t.id === this._topic);
    if(topic) {
      Widgets.focus(EC_FIND_ALWAYS + "|" + topic.find);
      Widgets.plot(EC_ALWAYS.concat(topic.plot), EC_BIG.concat(topic.big));
      Widgets.mute(topic.mute, ecNamed(topic.text).concat(EC_FIND_ALWAYS.split("|"), EC_WATCH));
      // Two topics are about a table.
      // Asking for it is a courtesy to the panel next door, not a requirement:
      // the guide reads the same either way.
      if(topic.table) Widgets.tell("ectra-tables", { table: topic.table });
    }
    else Widgets.release();
    try { localStorage.setItem(EC_TOPIC_KEY, this._topic || ""); }
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
    const topic = EC_TOPICS.find(t => t.id === this._topic);
    const now = ecNow();
    const missing = EC_USES.filter(name => !Reg.byName(name));
    const gap = missing.length > 0
      && `Tej mapie brakuje rejestrów, których używa przewodnik: ${missing.join(", ")}.`;
    return (
      <div class="ec ec-book">
        <div class="ec-tabs">
          {EC_TOPICS.map(t =>
            <button class={cls("ec-tab", t.id === this._topic && "on")}
              onClick={() => Ectra.pick(t.id)}>
              {t.label}
            </button>)}
        </div>
        {now.length > 0 && <Now lines={now} />}
        <div class="ec-text" onMouseLeave={() => Widgets.point(null)}>
          {gap && <Para text={gap} />}
          {(topic ? topic.text : EC_INTRO).split("\n").map(par => <Para text={par} />)}
        </div>
      </div>
    );
  },
};

try { Ectra._topic = localStorage.getItem(EC_TOPIC_KEY) || null; }
catch(e) { /* defaults stand */ }
if(!EC_TOPICS.some(t => t.id === Ectra._topic)) Ectra._topic = null;

Widgets.register(Ectra);
