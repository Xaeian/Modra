# Widgety

Panel dla jednej rodziny urządzeń, który pokazuje to, czego nie pokaże ogólna siatka rejestrów - tabelę przeliczeń, krzywą strojenia.
Wyłącznie frontend: bez backendu, bez stanu w `view.json`, bez trwałego DOM.

## Dodawanie widgetu

Plik `scripts/widgets/<id>.jsx` kończy się wywołaniem `Widgets.register(<Obj>)`, style leżą w `styles/widgets-<id>.css`, a id jest wpisane w `app.ini`.
Oba pliki trafiają do bundla automatycznie.

```js
{
  id: "vftab",  // musi odpowiadać wpisowi w app.ini
  title: "Drive · V/f table",
  match(regs),  // czy mapa zawiera potrzebne rejestry
  View(),       // JSX z treścią panelu
}
```

`match` sprawdza nazwy rejestrów, nigdy identyfikator urządzenia.
Mapa rejestrów jest tutaj jedynym źródłem prawdy o urządzeniu.

## Bramki

Widget pojawia się, gdy spełnione są oba warunki: id jest wpisane w `app.ini`, a `match()` akceptuje mapę.
Wtedy przycisk 🧩 (klawisz `w`) pokazuje panele.
Gdy nic nie pasuje, przycisk w ogóle się nie renderuje.
`app.ini` decyduje o aktywacji, nie o kompilacji - niewpisany widget nadal jest w paczce, tylko nieaktywny.

## Zasady

- Czytaj `S`, nigdy do niego nie pisz.
  Wartości urządzenia idą przez `writeNow(patch)`, a stan UI przez `actions.js`.
  Nigdy nie wołaj `API.write` bezpośrednio.
- `View()` jest przebudowywany około dwa razy na sekundę.
  Wszystko, czego render nie może zgubić, trzymaj na obiekcie widgetu.
- `ref` odpala się na odłączonym węźle: nadaje się do `addEventListener` i `innerHTML`, nie nadaje się do layoutu, fokusu ani przewijania.
- Runtime JSX nie tworzy węzłów SVG - wstaw SVG jako markup przez `ref`.
- Przycisk traci fokus przy następnym renderze, a pole tekstowe traci kursor, jeżeli nie ma klasy `.wg-hold`.
  Preferuj przyciski i selecty.
- Nie używaj `stopPropagation()` na kliknięciu - sterownik renderu opróżnia odroczone rendery w listenerze kliknięć na dokumencie.
- Preferencje trzymaj w `localStorage` pod kluczami `modra.<id>.*`.

## Rytm zapisów

Zapis odczytuje z powrotem rejestry, które zapisał, więc `S.values` zawiera to, co urządzenie przechowało, a nie echo żądania.
Pętla sterowania powinna łączyć swoje rejestry w jeden patch i czekać na każdy zapis - wtedy dostosowuje tempo do łącza, zamiast ustawiać się w kolejce za nim.
Każdy krok powinna liczyć od `S.values`, żeby przycięty albo odrzucony zapis został skorygowany, a nie skumulowany.
