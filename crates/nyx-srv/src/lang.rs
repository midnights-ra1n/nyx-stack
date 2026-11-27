//! Notifications in the language of their channel. Events are recorded in English, from
//! the patterns below; a channel in another language finds the pattern a text was built
//! from and fills its translation. Text that matches none stays as it is.

/// English pattern, French text. Most specific first: the first match wins.
const FR: &[(&str, &str)] = &[
    ("Resolved: {msg}", "Résolu : {msg}"),
    ("{host} is not responding", "{host} ne répond plus"),
    ("{host}: {n} updates available", "{host} : {n} mises à jour disponibles"),
    ("{n} security updates", "{n} mises à jour de sécurité"),
    ("{host}: memory at {p}%", "{host} : mémoire à {p} %"),
    ("{host}: CPU at {p}% for 5 minutes", "{host} : CPU à {p} % depuis 5 minutes"),
    ("{host}: swap at {p}%", "{host} : swap à {p} %"),
    ("{host}: restart required", "{host} : redémarrage requis"),
    ("{host}: VPN {iface} ({kind}) is down", "{host} : VPN {iface} ({kind}) coupé"),
    ("{host}: container {name} uses {p}% of its memory limit", "{host} : le conteneur {name} utilise {p} % de sa limite mémoire"),
    ("{host}: container {name} {what}", "{host} : le conteneur {name} {what}"),
    ("keeps restarting", "redémarre en boucle"),
    ("is unhealthy", "est en mauvaise santé"),
    ("stopped with an error", "s'est arrêté sur une erreur"),
    ("{host}: service {name} failed ({result})", "{host} : le service {name} a échoué ({result})"),
    ("{name}: certificate expires in {days} days", "{name} : le certificat expire dans {days} jours"),
    ("{name} is down: {msg}", "{name} est hors service : {msg}"),
    ("{host}: {t} °C", "{host} : {t} °C"),
    ("{host}: {mount} at {p}%", "{host} : {mount} à {p} %"),
    ("{n} bad sectors", "{n} secteurs défectueux"),
    ("{n}% life left", "{n} % de vie restante"),
    ("SMART self-assessment failed", "échec de l'auto-diagnostic SMART"),
    ("NVMe critical warning {n}", "alerte critique NVMe {n}"),
    ("EDF Tempo tomorrow: {color}", "EDF Tempo demain : {color}"),
    ("🔵 Blue", "🔵 Bleu"),
    ("⚪️ White", "⚪️ Blanc"),
    ("🔴 Red", "🔴 Rouge"),
    ("Days left: {blue} blue, {white} white, {red} red", "Jours restants : {blue} bleus, {white} blancs, {red} rouges"),
    ("Task due: {title}", "Tâche à faire : {title}"),
    ("Deployment planned: {name}", "Déploiement prévu : {name}"),
    ("Intervention planned: {name}", "Intervention prévue : {name}"),
    ("no answer from the agent", "pas de réponse de l'agent"),
    // Loose shapes last: they would take the ones above.
    ("{name}: {label} is {value}", "{name} : {label} = {value}"),
    // SMART: the device, then the agent's reason.
    ("{host}: {device} {reason}", "{host} : {device} {reason}"),
];

/// Parts that are text of their own, translated in turn. Every other part is a name.
const NESTED: [&str; 4] = ["msg", "reason", "what", "color"];
/// Parts that are numbers, so that "{n} bad sectors" does not take a whole title.
const NUMBERS: [&str; 4] = ["n", "p", "t", "days"];

pub const LANGS: [&str; 2] = ["en", "fr"];

pub fn tr(lang: &str, text: &str) -> String {
    let table = match lang {
        "fr" => FR,
        _ => return text.to_string(),
    };
    for (from, to) in table {
        if let Some(parts) = parts(from, text) {
            let mut out = to.to_string();
            for (name, value) in parts {
                let value = if NESTED.contains(&name) { tr(lang, value) } else { value.to_string() };
                out = out.replace(&format!("{{{name}}}"), &value);
            }
            return out;
        }
    }
    text.to_string()
}

/// `(name, value)` of each `{name}` of `pattern`, when `text` was built from it.
fn parts<'a>(pattern: &'a str, text: &'a str) -> Option<Vec<(&'a str, &'a str)>> {
    let mut segs = pattern.split('{').peekable();
    let mut rest = text.strip_prefix(segs.next()?)?;
    let mut out = vec![];
    while let Some(seg) = segs.next() {
        let (name, lit) = seg.split_once('}')?;
        let value = if segs.peek().is_none() {
            std::mem::take(&mut rest).strip_suffix(lit)?
        } else {
            let at = rest.find(lit).filter(|_| !lit.is_empty())?;
            let value = &rest[..at];
            rest = &rest[at + lit.len()..];
            value
        };
        if value.is_empty() || (NUMBERS.contains(&name) && !value.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')) {
            return None;
        }
        out.push((name, value));
    }
    rest.is_empty().then_some(out)
}

/// Words of the message itself, around the events.
pub fn word(lang: &str, key: &str) -> &'static str {
    let fr = lang == "fr";
    match key {
        "state" => if fr { "État" } else { "State" },
        "update" => if fr { "Mises à jour" } else { "Updates" },
        "smart" => "SMART",
        "temperature" => if fr { "Température" } else { "Temperature" },
        "task" => if fr { "Tâches" } else { "Tasks" },
        "tempo" => "EDF Tempo",
        "pipeline" => "Pipelines",
        "crit" => if fr { "Critique" } else { "Critical" },
        "warn" => if fr { "Attention" } else { "Warning" },
        "ok" => if fr { "Résolu" } else { "Resolved" },
        _ => "Info",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_pattern_and_translates_nested_text_only() {
        assert_eq!(tr("fr", "nas-01: /dev/sdb 8 bad sectors"), "nas-01 : /dev/sdb 8 secteurs défectueux");
        assert_eq!(tr("fr", "Resolved: web: container nginx keeps restarting"), "Résolu : web : le conteneur nginx redémarre en boucle");
        assert_eq!(tr("fr", "web: memory at 91%"), "web : mémoire à 91 %");
        assert_eq!(tr("fr", "web: CPU at 97% for 5 minutes"), "web : CPU à 97 % depuis 5 minutes");
        assert_eq!(tr("fr", "web: restart required"), "web : redémarrage requis");
        assert_eq!(tr("fr", "nas: /srv/data at 87%"), "nas : /srv/data à 87 %");
        assert_eq!(tr("fr", "docker-01: 12 updates available"), "docker-01 : 12 mises à jour disponibles");
        assert_eq!(tr("fr", "EDF Tempo tomorrow: 🔴 Red"), "EDF Tempo demain : 🔴 Rouge");
        // A host called like a word of the table keeps its name.
        assert_eq!(tr("fr", "Blue is not responding"), "Blue ne répond plus");
    }

    #[test]
    fn unknown_text_and_english_stay_as_they_are() {
        assert_eq!(tr("fr", "Something new"), "Something new");
        assert_eq!(tr("en", "web: memory at 91%"), "web: memory at 91%");
        assert_eq!(parts("{a}: {b}", "x: "), None);
        assert_eq!(parts("a {b} c", "a x c d"), None);
    }
}
