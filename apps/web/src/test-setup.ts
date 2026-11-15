// Unit tests run with the Russian catalogue active, as the app does by default.
import ru from './lib/i18n/ru.ts';
import { useStrings } from './lib/strings.ts';

useStrings('ru', ru);
import { setPageLang } from './lib/page-lang.ts';

setPageLang('ru');
