Nyx (nyx-stack) est un projet pour homelab qui sera distribué publiquement sur GitHub. Il s'agit d'un projet qui va permettre de gérer son homelab et le monitorer à distance. Il y aura 3 stack.
Ce projet devra être documenté en anglais et très documenté. En terme d'interface web je voudrais un mix entre Grafana, Beszel, Patchmon, Uptime Kuma et Zabbix ainsi que GLPI.


# Stack 1 : le manager

Le manager sera une interface web claire. Elle s'inspirera notamment de GLPI car le management va surtout contenir :
- Inventaire matériel
- Inventaire virtuel (machines virtuelles, conteneurs, etc...)
- IPAM (gestion d'adressage IP, détection de conflits dans l'attribution d'adresses IP et simulation de routage, etc...)
- Suivi de déploiements
- carte réseau (avec export dans plusieurs formats)
- Plateforme Node.js. Si l'utilisateur a Node.js d'installé dans sa VM et s'en sert pour déployer des applications web. Il va falloir détecter ça et avoir une très bonne gestion des sites et déploiement notamment aussi avec git, pouvoir ajouter une clé SSH, redéployer lors d'un nouveau commit et push.



# Stack 2 : le monitoring

Le monitoring sera aussi une interface web. Elle reprendra beaucoup Grafana pour un dashboard, et aussi un mix de Beszel et Patchmon ainsi que Zabbix un peu et UptimeKuma. Je voudrais pouvoir ajouter des sondes de surveillance tel que la surveillance via un ping ICMP, site internet, serveur DNS. Surveillance de certificats HTTPS.




# Stack 3 : l'agent

Il s'agira d'un petit service systemd et un seul binaire écrit en Rust qui va s'exécuter de manière permanente sur l'hôte et de fonctionner de le plus discrètement possible.
Il pourra se déployer à la main via un bouton "Ajouter un hôte" et ensuite on va générer un lien curl d'installation avec token, clé, URL de l'instance et type de déploiement.
Les types de déploiement à prendre en charge et à inclure dans la ligne curl :
- VM
- Serveur physique (Non Proxmox)
- Serveur physique (Proxmox) avec si activé installation dans des CT Proxmox et détection et installation de l'agent dans les nouveaux CT
- VPS

La surveillance SMART est obligatoire dans les déploiements/installations dans des hôtes physiques.

Je dois pouvoir aussi inclure cet agent dans un playbook Ansible. On doit avoir :
- token de l'agent
- clé de l'agent
- URL de l'instance de monitoring
- type de déploiement

Au même titre que si j'installais via la ligne curl.
J'aimerais pouvoir aussi changer le type d'hôte (Proxmox, VM, serveur physique...) à chaud sans à devoir tout réinstaller

## Ce que l'agent devra collecter

L'agent devra collecter les métriques suivantes :
- Uptime
- Usage CPU
- Usage RAM/swap
- Usage réseau
- Usage disque
- Uniquement pour les serveurs physiques la collecte de l'état SMART et affichage de l'état de santé du disque de manière simplifiée et sa durée de vie restante avec seuil de santé.
- Etat des conteneurs Docker
- Gestion des mises à jour du système (possibilité de mettre à jour le système) et de l'agent lui même
- Tempêrature de l'hote
- Collecte des logs sur le système et toujours de manière simplifiée et légère en écriture/lecture


# Frontend

Pour le frontend j'aimerais avoir une interface web claire et simplifiée, c'est pour cela qu'à la racine du dossier tu trouvera Nyx-DA-guide.pdf ainsi que nyx-mark.svg qui seront le logo et directives pour ce projet là. Je voudrais utiliser React et TailwindCSS. Pas de communication avec des CDN (Google Fonts par exemple) ou autres tiers. Il faut que ça reste privacy first.
J'aimerais que ça reste très personnalisable, une liste d'hôtes en arborescence en fonction de ce qui est dans une VM Proxmox...

# Backend

Je voudrais un backend entièrement écrit en Rust pour avoir un agent et un serveur le plus léger et discret possible en ressources que ce soit sur l'hôte faisant fonctionner le serveur ou l'agent. Côté base de données je voudrais utiliser Pocketbase. Je voudrais très peu d'écriture sur le disque, peu de CPU utilisé ou de latence I/O.

# Intégrations

Je voudrais pouvoir intégrer des petites choses de manière externe.
Je voudrais intégrer Nextcloud, plutôt la partie calendrier et tâches pour une intégration dans les tâches à effectuer, et une synchro complète et instantanée.
Je voudrais intégrer aussi l'API de RTE France si on veut ajouter les jours d'EDF Tempo (jours bleu/blanc/rouge restants, la couleur du jour actuel et celle de demain...)
Je voudrais intégrer Proxmox pour l'intégration d'une console noVNC (un bouton dédié)
Je voudrais une intégration de Meross pour pouvoir mesurer la consommation éléctrique des prises.
Je voudrais une intégration de serveur MCP, où je peux créer un serveur MCP et le relier à Claude, ChatGPT/Codex etc... et donc en un prompt pouvoir visualiser par exemple l'état général de mon infrastructure. Tout cela le MCP devra se faire seulement en HTTPS.
Je voudrais aussi pouvoir créer des passkeys, idem que pour le MCP où il faudra être en HTTPS.

# Plateformes

Je voudrais que l'agent, serveur de management, serveur de monitoring puissent être déployés via Docker en x86 et arm64. Et également des binaires pour Debian/Ubuntu (.deb) et pour RHEL/Fedora/Alama (.rpm).
Pour les serveurs déployés via binaire, on peut dans les paramètres inclure un système de mise à jour et pour les agents un système de mise à jour quotidienne automatique ou forcé à la main.

# Séparation des rôles

L'agent, le monitoring et le management devront être séparés dans le cas où si on souhaite avoir uniquement le manager sans le monitoring et l'agent ou bien avoir uniquement le monitoring et l'agent et pas le manager. Mais derrière on peut de manière optionnelle avoir une cohésion entre les deux.

# Notifications

Je voudrais qu'on puisse pouvoir avoir un système de notifications. Comme types de notifications il faut qu'on ai du mail, webhook Discord, Matrix, Slack, Gotify, Ntfy, Telegram, Teams etc... J'aimerais un peu standardiser tout ça en utilisant Shoutrrr https://github.com/containrrr/shoutrrr donc il va falloir intégrer du Go en plus du rust dans la mesure du possible. L'apparance du mail ainsi que l'apparance des notifications (Discord etc...) devra être très personnalisable avec un preview à côté. Pour la fréquence d'envoi, je ne veux pas me faire spammer de mails ou de notifications donc on doit pouvoir grouper et laisser un espace. Ce qui doit être monitoré pour les envois de notifications :
- changement d'état
- détection de mises à jour
- états smart à surveiller (faire attention ou état critique)
- tempêrature élevée
- rappels de tâches/déploiements

Pour les mises à jour par exemple et pour tout, il peut check tous les jours à une heure donnée et m'envoyer un mail chaque mois à un moment donné plutot que de m'envoyer un message à chaque fois. 
