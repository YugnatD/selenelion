/**
 * Every user-facing string in the app, in English (the default) and French.
 *
 * `EN` is the source of truth: `FR` is typed as `Dict = typeof EN`, so adding a key to EN without
 * translating it, or letting the two drift apart in shape, is a compile error rather than a
 * string that silently falls back to the wrong language at runtime.
 *
 * Values are either plain strings or functions taking an interpolation object. Functions are used
 * wherever a sentence embeds a value, rather than concatenating fragments at the call site —
 * word order differs between languages ("5 days" / "5 jours" is easy, but "Moon below the horizon"
 * / "Lune sous l'horizon" only stays natural if the whole sentence is translated as a unit).
 */

export const EN = {
    // --- shell / views -----------------------------------------------------------------
    'view.2d': '2D map',
    'view.obstruction': 'Obstruction',
    'view.weather': 'Weather',
    'view.focus': 'Quality',
    'view.3d': '3D view',
    'view.lockedDuringExport': 'PDF export running — wait for it to finish before switching view',
    'lang.label': 'Language',

    // --- eclipse picker ----------------------------------------------------------------
    'selector.modeGroup': 'Eclipse type',
    'selector.solar': 'Solar',
    'selector.lunar': 'Lunar',
    'selector.label': 'Eclipse',
    'selector.computingLunar': 'Computing lunar eclipses…',
    'selector.empty': '—',
    'selector.lockedDuringExport': 'PDF export running — wait for it to finish before changing eclipse',

    // --- eclipse types -----------------------------------------------------------------
    'type.total': 'Total',
    'type.annular': 'Annular',
    'type.partial': 'Partial',
    'type.hybrid': 'Hybrid',
    'type.none': 'No eclipse visible',
    'lunarType.total': 'Total',
    'lunarType.partial': 'Partial',
    'lunarType.penumbral': 'Penumbral',

    // --- circumstances panel, shared ---------------------------------------------------
    'panel.loading': 'Computing…',
    'panel.error': (p: { message: string }) => `Error: ${p.message}`,
    'panel.selectedPlace': 'Selected location',
    'panel.coordinates': 'Coordinates',
    'panel.timezone': 'Time zone',
    'panel.max': 'Maximum',

    // --- circumstances panel, solar ----------------------------------------------------
    'panel.saros': 'Saros',
    'panel.greatestEclipse': 'Greatest eclipse',
    'panel.maxMagnitude': 'Max. magnitude',
    'panel.pathWidth': 'Path width',
    'panel.maxCentralDuration': 'Max. central duration',
    'panel.localTimeNote': 'Times are shown in the local time of the place concerned.',
    'panel.clickToSee': 'Click the map to see local circumstances.',
    'panel.notVisibleAt': (p: { lat: string; lon: string }) => `Eclipse not visible at ${p.lat}, ${p.lon}.`,
    'panel.computingShort': 'Computing…',
    'panel.localLoadFailed': 'Could not load local circumstances for this point (network?).',
    'panel.alreadyPinned': 'Already pinned',
    'panel.comparisonFull': 'Comparison full (3 max)',
    'panel.pin': 'Pin for comparison',
    'panel.localType': 'Local type',
    'panel.c1': 'First contact (C1)',
    'panel.c2': 'Central phase begins (C2)',
    'panel.c3': 'Central phase ends (C3)',
    'panel.c4': 'Last contact (C4)',
    'panel.localMagnitude': 'Local magnitude',
    'panel.centralDuration': 'Central duration',
    'panel.terrainHeading': 'Visibility given the terrain',
    'panel.terrainLoading': 'Analysing the surrounding terrain…',
    'panel.terrainError': 'Could not load the terrain for this point (network?).',
    'panel.visibleDuration': 'Visible duration',
    'panel.centralClear': 'Central phase clear of the terrain',
    'panel.centralBlocked': 'Central phase hidden by the terrain',
    'panel.peakfinderLink': 'View the panorama on PeakFinder ↗',
    'panel.peakfinderName': (p: { date: string }) => `Eclipse ${p.date}`,
    'panel.peakfinderDetail': (p: { azimuth: string; altitude: string; central: boolean }) =>
        `azimuth ${p.azimuth}°, altitude ${p.altitude}° at ${p.central ? 'the central phase' : 'maximum eclipse'}.`,

    // --- circumstances panel, lunar ----------------------------------------------------
    'lunar.heading': (p: { type: string }) => `Lunar — ${p.type}`,
    'lunar.p1': 'Penumbral begins (P1)',
    'lunar.u1': 'Partial begins (U1)',
    'lunar.u2': 'Totality begins (U2)',
    'lunar.u3': 'Totality ends (U3)',
    'lunar.u4': 'Partial ends (U4)',
    'lunar.p4': 'Penumbral ends (P4)',
    'lunar.umbralMagnitude': 'Umbral magnitude',
    'lunar.globalNote': (p: { hasPoint: boolean }) =>
        `A lunar eclipse happens at the same instant everywhere: these times are identical across the whole Earth${
            p.hasPoint ? ', shown here in the local time of the selected location' : ' (shown in UTC)'
        }. All that changes with location is whether the Moon is above your horizon.`,
    'lunar.clickToSee': 'Click the map to see whether the Moon is up from this place.',
    'lunar.moonBelowAll': 'Moon below the horizon for the whole eclipse',
    'lunar.totalityVisible': 'Totality visible',
    'lunar.totalityNotVisible': 'Totality not visible here',
    'lunar.peakfinderName': (p: { date: string }) => `Lunar eclipse ${p.date}`,
    'lunar.peakfinderDetail': (p: { azimuth: string; altitude: string }) =>
        `azimuth ${p.azimuth}°, altitude ${p.altitude}° at maximum.`,

    // --- weather section ---------------------------------------------------------------
    'weather.heading': 'Weather',
    'weather.dayWindowGroup': 'Climatology averaging window',
    'weather.day': 'Day',
    'weather.days': (p: { count: number }) => `${p.count} days`,
    'weather.hourGroup': 'Hourly precision',
    'weather.wholeDay': 'Whole day',
    'weather.eclipseHour': 'Eclipse hour',
    'weather.loading': 'Analysing the weather…',
    'weather.error': 'Could not load the climatology (network?).',
    'weather.noData': 'No weather data for this place.',
    'weather.cloudCover': (p: { percent: number }) => `${p.percent}% cloud cover`,
    'weather.headlineNote': (p: { hour: boolean; window: number; baseline: string }) =>
        `${p.hour ? 'Averaged around the eclipse hour' : 'Averaged over the day'}${
            p.window === 1 ? '' : `, over ${p.window} days around the date`
        }, ${p.baseline} climatology.`,
    'weather.seasonalNote': (p: { hour: boolean; window: number; baseline: string }) =>
        `Mean cloud cover${p.hour ? ' around the eclipse hour' : ''} through the year at this place (${
            p.baseline
        }) — the marker shows the eclipse date${p.window > 1 ? `, curve smoothed over ${p.window} days` : ''}.`,
    'weather.weeklyNote': (p: { baseline: string }) =>
        `Cloud cover at the eclipse hour, day by day across the week (${p.baseline}) — each bar is one day, not averaged together.`,
    'weather.dayProfileNote': (p: { baseline: string }) =>
        `Cloud cover in 2-hour slots on the eclipse's own day (${p.baseline}) — shows whether the eclipse hour falls in a historically clearer or cloudier stretch than the rest of that day.`,

    // --- charts ------------------------------------------------------------------------
    'chart.horizonAria': "Horizon profile and the body's track during the eclipse",
    'chart.terrain': 'Terrain',
    'chart.sun': 'Sun',
    'chart.moon': 'Moon',
    'chart.compassN': 'N',
    'chart.compassE': 'E',
    'chart.compassS': 'S',
    'chart.compassW': 'W',
    'chart.horizonTooltip': (p: { azimuth: number; terrain: string }) => `${p.azimuth}° · terrain ${p.terrain}°`,
    'chart.horizonTooltipBody': (p: { body: string; altitude: string; time: string }) => ` · ${p.body} ${p.altitude}° at ${p.time}`,
    'chart.seasonalAria': 'Mean cloud cover through the year at this place',
    'chart.weeklyAria': 'Cloud cover at the eclipse hour, day by day across the week',
    'chart.dayProfileAria': 'Cloud cover by time of day on the eclipse day',
    'chart.eclipseDay': 'Eclipse',

    // --- map overlays ------------------------------------------------------------------
    'map.loadError': 'Could not load the base map (network?). The eclipse data is still available in the panel.',
    'map.zoomForObstruction': 'Zoom in on the path to see terrain obstruction.',
    'map.zoomForMoon': 'Zoom in to see where the Moon is up.',
    'map.zoomForScore': 'Zoom in on the path to see the quality score.',
    'map.computingTerrain': 'Computing terrain…',
    'map.computingWeather': 'Computing weather…',
    'map.computingScore': 'Computing score (terrain + weather)…',
    'map.weatherError': 'Could not load the weather (network?).',
    'legend.blocked': 'Blocked',
    'legend.clear': 'Clear',
    'legend.moonNotVisible': 'Moon not up',
    'legend.moonVisible': 'Moon up',
    'legend.lunarNote': 'Share of the eclipse with the Moon above the horizon',
    'legend.covered': 'Overcast',
    'legend.clearSky': 'Clear',
    'legend.low': 'Poor',
    'legend.excellent': 'Excellent',
    'legend.weatherNote': (p: { window: number; baseline: string }) =>
        p.window === 1 ? `Daily mean, ${p.baseline} climatology` : `Mean over ${p.window} days, ${p.baseline} climatology`,
    'legend.scoreFormula': 'Score = terrain × weather',
    'legend.scoreFormulaDuration': 'Score = terrain × weather × duration',

    // --- quality (focus) view ----------------------------------------------------------
    'focus.durationGroup': 'Duration weighting',
    'focus.withDuration': 'With duration',
    'focus.withoutDuration': 'Without',
    'focus.computingPointScore': 'Computing the score at the selected point…',
    'focus.pointScoreLabel': 'Score at the selected point',
    'focus.pointNotSeeing': 'This point does not see the eclipse.',
    'focus.noScoreSolar': 'Outside the totality band — no score here.',
    'focus.noScoreLunar': 'Score unavailable here (terrain or weather missing).',
    'focus.outsideCentrality': 'Outside the centrality band — the score only covers the totality zone. Move onto the path.',
    'focus.noClimatology': 'No climatology data over this area — move to a covered region.',

    // --- 2D map lunar legend -----------------------------------------------------------
    'lunarLegend.whole': 'Whole eclipse visible',
    'lunarLegend.below': 'Moon below the horizon',
    'lunarLegend.note':
        'Light zone: the Moon is up for the whole eclipse. In the intermediate band it rises or sets partway through. The line marks the lunar horizon at maximum.',

    // --- best points -------------------------------------------------------------------
    'best.heading': 'Best spot on the path',
    'best.search': 'Find the clearest spots',
    'best.searchAgain': 'Search again',
    'best.loading': 'Searching along the path (weather + terrain)…',
    'best.none': 'No land point with terrain-clear centrality found along this path (sampled stretch over water, or terrain blocking everywhere?).',
    'best.item': (p: { lat: string; lon: string; cloud: number; magnitude: string; visible: number }) =>
        `${p.lat}, ${p.lon} — ${p.cloud}% cloud, magnitude ${p.magnitude}, ${p.visible}% visible (terrain)`,
    'best.note': 'Only shows points where the terrain does not block the central phase.',

    // --- comparison --------------------------------------------------------------------
    'comparison.heading': 'Comparison',
    'comparison.type': 'Type',
    'comparison.magnitude': 'Magnitude',
    'comparison.centrality': 'Centrality',
    'comparison.cloudCover': 'Cloud cover',
    'comparison.remove': 'Remove from comparison',

    // --- 3D view -----------------------------------------------------------------------
    'scene3d.loading': 'Loading the 3D view…',
    'scene3d.selectPoint': 'Select a point on the 2D map to show the 3D view.',
    'scene3d.notVisible': 'Eclipse not visible at this point.',
    'scene3d.terrainError': 'Could not load the terrain for this point (network?).',
    'scene3d.analysing': 'Analysing the terrain…',
    'scene3d.hint': 'Drag to look around · scroll to zoom',
    'scene3d.hintLunar': 'Drag to look around · scroll to zoom · the disc follows the Moon',
    'scene3d.statusCentral': 'central phase',
    'scene3d.statusVisible': 'visible',
    'scene3d.statusBlocked': 'hidden by the terrain',
    'scene3d.statusBelowHorizon': 'below the horizon',
    'scene3d.belowHorizonNote': (p: { lunar: boolean; altitude: string }) =>
        `The ${p.lunar ? 'Moon' : 'Sun'} is below the horizon at this instant (${p.altitude}°) — move the time slider to a moment when it is up.`,

    // --- PDF export --------------------------------------------------------------------
    'export.button': 'Export to PDF',
    'export.inProgress': 'Export running…',
    'export.preparing': 'Preparing…',
    'export.stageShowView': (p: { view: string }) => `Showing the view (${p.view})…`,
    'export.stageTerrain': 'Computing detailed terrain',
    'export.stageVisibility': 'Computing detailed visibility',
    'export.stageWeather': 'Fetching weather',
    'export.stageSub': (p: { label: string; view: string }) => `${p.label} (${p.view})…`,
    'export.stageLayout': (p: { view: string }) => `Laying out (${p.view})…`,
    'export.stageWriting': 'Writing the file…',
    'export.stageDone': 'Done',
    'export.errNoEclipse': 'No eclipse selected',
    'export.errNothingExported': 'No view could be exported.',
    'export.errBadLunarSummary': 'Invalid lunar eclipse summary — cannot export.',
    'export.skippedWarning': (p: { views: string[] }) =>
        `PDF generated, but ${p.views.length > 1 ? 'these views were' : 'this view was'} skipped: ${p.views.join(', ')}.`,
    'export.focusWithDuration': ' (with duration)',
    'export.focusWithoutDuration': ' (without duration)',
    'export.pageTitle': (p: { lunar: boolean; view: string }) => `${p.lunar ? 'Lunar eclipse' : 'Eclipse'} — ${p.view}`,
    'export.subtitleSolar': (p: { type: string; date: string; magnitude: string }) => `${p.type} — ${p.date} — magnitude ${p.magnitude}`,
    'export.subtitleLunar': (p: { type: string; date: string; magnitude: string }) =>
        `Lunar ${p.type} — ${p.date} — umbral magnitude ${p.magnitude}`,

    // --- engine errors -----------------------------------------------------------------
    'error.noLunarEclipse': (p: { date: string }) => `No lunar eclipse around ${p.date}`,
};

export type Dict = typeof EN;
export type StringKey = keyof Dict;

export const FR: Dict = {
    'view.2d': 'Carte 2D',
    'view.obstruction': 'Obstruction',
    'view.weather': 'Météo',
    'view.focus': 'Qualité',
    'view.3d': 'Vue 3D',
    'view.lockedDuringExport': "Export PDF en cours — attendez qu'il se termine pour changer de vue",
    'lang.label': 'Langue',

    'selector.modeGroup': "Type d'éclipse",
    'selector.solar': 'Solaire',
    'selector.lunar': 'Lunaire',
    'selector.label': 'Éclipse',
    'selector.computingLunar': 'Calcul des éclipses lunaires…',
    'selector.empty': '—',
    'selector.lockedDuringExport': "Export PDF en cours — attendez qu'il se termine pour changer d'éclipse",

    'type.total': 'Totale',
    'type.annular': 'Annulaire',
    'type.partial': 'Partielle',
    'type.hybrid': 'Hybride',
    'type.none': "Pas d'éclipse visible",
    'lunarType.total': 'Totale',
    'lunarType.partial': 'Partielle',
    'lunarType.penumbral': 'Pénombrale',

    'panel.loading': 'Calcul en cours…',
    'panel.error': (p) => `Erreur : ${p.message}`,
    'panel.selectedPlace': 'Lieu sélectionné',
    'panel.coordinates': 'Coordonnées',
    'panel.timezone': 'Fuseau horaire',
    'panel.max': 'Maximum',

    'panel.saros': 'Saros',
    'panel.greatestEclipse': 'Plus grande éclipse',
    'panel.maxMagnitude': 'Magnitude max.',
    'panel.pathWidth': 'Largeur de la bande',
    'panel.maxCentralDuration': 'Durée max. de centralité',
    'panel.localTimeNote': "Heures affichées à l'heure locale du lieu concerné.",
    'panel.clickToSee': 'Cliquez sur la carte pour voir les circonstances locales.',
    'panel.notVisibleAt': (p) => `Éclipse non visible à ${p.lat}, ${p.lon}.`,
    'panel.computingShort': 'Calcul…',
    'panel.localLoadFailed': 'Impossible de charger les circonstances locales pour ce point (réseau ?).',
    'panel.alreadyPinned': 'Déjà épinglé',
    'panel.comparisonFull': 'Comparaison pleine (3 max)',
    'panel.pin': 'Épingler pour comparer',
    'panel.localType': 'Type local',
    'panel.c1': 'Premier contact (C1)',
    'panel.c2': 'Début centralité (C2)',
    'panel.c3': 'Fin centralité (C3)',
    'panel.c4': 'Dernier contact (C4)',
    'panel.localMagnitude': 'Magnitude locale',
    'panel.centralDuration': 'Durée de centralité',
    'panel.terrainHeading': 'Visibilité selon le relief',
    'panel.terrainLoading': 'Analyse du relief environnant…',
    'panel.terrainError': 'Impossible de charger le relief pour ce point (réseau ?).',
    'panel.visibleDuration': 'Durée visible',
    'panel.centralClear': 'Centralité dégagée par le relief',
    'panel.centralBlocked': 'Centralité masquée par le relief',
    'panel.peakfinderLink': 'Voir le panorama sur PeakFinder ↗',
    'panel.peakfinderName': (p) => `Éclipse ${p.date}`,
    'panel.peakfinderDetail': (p) =>
        `azimut ${p.azimuth}°, hauteur ${p.altitude}° au moment de ${p.central ? 'la centralité' : "l'éclipse maximale"}.`,

    'lunar.heading': (p) => `Lunaire — ${p.type}`,
    'lunar.p1': 'Début pénombre (P1)',
    'lunar.u1': 'Début partielle (U1)',
    'lunar.u2': 'Début totalité (U2)',
    'lunar.u3': 'Fin totalité (U3)',
    'lunar.u4': 'Fin partielle (U4)',
    'lunar.p4': 'Fin pénombre (P4)',
    'lunar.umbralMagnitude': 'Magnitude ombrale',
    'lunar.globalNote': (p) =>
        `Une éclipse de Lune se produit au même instant partout : ces heures sont identiques sur toute la Terre${
            p.hasPoint ? ", affichées ici à l'heure locale du lieu sélectionné" : ' (affichées en UTC)'
        }. Seule change la question de savoir si la Lune est levée chez vous.`,
    'lunar.clickToSee': 'Cliquez sur la carte pour voir si la Lune est levée depuis ce lieu.',
    'lunar.moonBelowAll': "Lune sous l'horizon pendant toute l'éclipse",
    'lunar.totalityVisible': 'Totalité visible',
    'lunar.totalityNotVisible': 'Totalité non visible ici',
    'lunar.peakfinderName': (p) => `Éclipse de Lune ${p.date}`,
    'lunar.peakfinderDetail': (p) => `azimut ${p.azimuth}°, hauteur ${p.altitude}° au maximum.`,

    'weather.heading': 'Météo',
    'weather.dayWindowGroup': 'Fenêtre de moyennage climatologique',
    'weather.day': 'Jour',
    'weather.days': (p) => `${p.count} jours`,
    'weather.hourGroup': 'Précision horaire',
    'weather.wholeDay': 'Journée entière',
    'weather.eclipseHour': "Heure de l'éclipse",
    'weather.loading': 'Analyse de la météo…',
    'weather.error': 'Impossible de charger la climatologie (réseau ?).',
    'weather.noData': 'Pas de données météo pour ce lieu.',
    'weather.cloudCover': (p) => `${p.percent}% de nébulosité`,
    'weather.headlineNote': (p) =>
        `${p.hour ? "Moyenne vers l'heure de l'éclipse" : 'Moyenne du jour'}${
            p.window === 1 ? '' : `, sur ${p.window} jours autour de la date`
        }, climatologie ${p.baseline}.`,
    'weather.seasonalNote': (p) =>
        `Nébulosité moyenne${p.hour ? " vers l'heure de l'éclipse" : ''} au fil de l'année à ce lieu (${
            p.baseline
        }) — le repère marque la date de l'éclipse${p.window > 1 ? `, courbe lissée sur ${p.window} jours` : ''}.`,
    'weather.weeklyNote': (p) =>
        `Nébulosité à l'heure de l'éclipse, jour par jour sur la semaine (${p.baseline}) — chaque barre est un jour, non moyennés ensemble.`,
    'weather.dayProfileNote': (p) =>
        `Nébulosité par tranche de 2h, le jour même de l'éclipse (${p.baseline}) — pour voir si l'heure de l'éclipse tombe sur un créneau historiquement plus ou moins dégagé que le reste de la journée.`,

    'chart.horizonAria': "Profil de l'horizon et trajectoire de l'astre pendant l'éclipse",
    'chart.terrain': 'Relief',
    'chart.sun': 'Soleil',
    'chart.moon': 'Lune',
    'chart.compassN': 'N',
    'chart.compassE': 'E',
    'chart.compassS': 'S',
    'chart.compassW': 'O',
    'chart.horizonTooltip': (p) => `${p.azimuth}° · relief ${p.terrain}°`,
    'chart.horizonTooltipBody': (p) => ` · ${p.body} ${p.altitude}° à ${p.time}`,
    'chart.seasonalAria': "Nébulosité moyenne au fil de l'année à ce lieu",
    'chart.weeklyAria': "Nébulosité à l'heure de l'éclipse, jour par jour sur la semaine",
    'chart.dayProfileAria': "Nébulosité par tranche horaire, le jour de l'éclipse",
    'chart.eclipseDay': 'Éclipse',

    'map.loadError': "Impossible de charger le fond de carte (réseau ?). Les données d'éclipse restent disponibles dans le panneau.",
    'map.zoomForObstruction': "Zoomez sur le tracé pour voir l'obstruction par le relief.",
    'map.zoomForMoon': 'Zoomez pour voir où la Lune est levée.',
    'map.zoomForScore': 'Zoomez sur le tracé pour voir le score de qualité.',
    'map.computingTerrain': 'Calcul du relief…',
    'map.computingWeather': 'Calcul de la météo…',
    'map.computingScore': 'Calcul du score (relief + météo)…',
    'map.weatherError': 'Impossible de charger la météo (réseau ?).',
    'legend.blocked': 'Masqué',
    'legend.clear': 'Dégagé',
    'legend.moonNotVisible': 'Lune non levée',
    'legend.moonVisible': 'Lune levée',
    'legend.lunarNote': "Part de l'éclipse où la Lune est au-dessus de l'horizon",
    'legend.covered': 'Couvert',
    'legend.clearSky': 'Dégagé',
    'legend.low': 'Faible',
    'legend.excellent': 'Excellent',
    'legend.weatherNote': (p) =>
        p.window === 1 ? `Moyenne du jour, climatologie ${p.baseline}` : `Moyenne sur ${p.window} jours, climatologie ${p.baseline}`,
    'legend.scoreFormula': 'Score = relief × météo',
    'legend.scoreFormulaDuration': 'Score = relief × météo × durée',

    'focus.durationGroup': 'Prise en compte de la durée',
    'focus.withDuration': 'Avec durée',
    'focus.withoutDuration': 'Sans',
    'focus.computingPointScore': 'Calcul du score au point sélectionné…',
    'focus.pointScoreLabel': 'Score au point sélectionné',
    'focus.pointNotSeeing': "Ce point ne voit pas l'éclipse.",
    'focus.noScoreSolar': 'Hors zone de totalité — pas de score ici.',
    'focus.noScoreLunar': 'Score indisponible ici (relief ou météo manquants).',
    'focus.outsideCentrality': 'Hors de la bande de centralité — le score ne couvre que la zone de totalité. Déplacez-vous sur le tracé.',
    'focus.noClimatology': 'Pas de données de climatologie sur cette zone — déplacez-vous sur une région couverte.',

    'lunarLegend.whole': 'Éclipse entière visible',
    'lunarLegend.below': "Lune sous l'horizon",
    'lunarLegend.note':
        "Zone claire : la Lune est levée pendant toute l'éclipse. Dans la bande intermédiaire elle se lève ou se couche en cours d'éclipse. Le trait marque l'horizon lunaire au maximum.",

    'best.heading': 'Meilleur endroit sur le tracé',
    'best.search': 'Chercher les endroits les plus dégagés',
    'best.searchAgain': 'Rechercher à nouveau',
    'best.loading': 'Recherche le long du tracé (météo + relief)…',
    'best.none':
        "Aucun point terrestre avec centralité dégagée par le relief trouvé le long de ce tracé (portion échantillonnée au-dessus de l'eau, ou relief bloquant partout ?).",
    'best.item': (p) => `${p.lat}, ${p.lon} — ${p.cloud}% nébulosité, magnitude ${p.magnitude}, ${p.visible}% visible (relief)`,
    'best.note': 'Ne montre que les points où le relief ne bloque pas la centralité.',

    'comparison.heading': 'Comparaison',
    'comparison.type': 'Type',
    'comparison.magnitude': 'Magnitude',
    'comparison.centrality': 'Centralité',
    'comparison.cloudCover': 'Nébulosité',
    'comparison.remove': 'Retirer de la comparaison',

    'scene3d.loading': 'Chargement de la vue 3D…',
    'scene3d.selectPoint': 'Sélectionnez un point sur la carte 2D pour afficher la vue 3D.',
    'scene3d.notVisible': 'Éclipse non visible à ce point.',
    'scene3d.terrainError': 'Impossible de charger le relief pour ce point (réseau ?).',
    'scene3d.analysing': 'Analyse du relief…',
    'scene3d.hint': 'Glisser pour regarder autour · molette pour zoomer',
    'scene3d.hintLunar': 'Glisser pour regarder autour · molette pour zoomer · le disque suit la Lune',
    'scene3d.statusCentral': 'centralité',
    'scene3d.statusVisible': 'visible',
    'scene3d.statusBlocked': 'masqué par le relief',
    'scene3d.statusBelowHorizon': "sous l'horizon",
    'scene3d.belowHorizonNote': (p) =>
        `${p.lunar ? 'La Lune est' : 'Le Soleil est'} sous l'horizon à cet instant (${p.altitude}°) — déplacez le curseur de temps pour trouver un moment où ${
            p.lunar ? 'elle est levée' : 'il est levé'
        }.`,

    'export.button': 'Exporter en PDF',
    'export.inProgress': 'Export en cours…',
    'export.preparing': 'Préparation…',
    'export.stageShowView': (p) => `Affichage de la vue (${p.view})…`,
    'export.stageTerrain': 'Calcul du relief détaillé',
    'export.stageVisibility': 'Calcul de la visibilité détaillée',
    'export.stageWeather': 'Récupération météo',
    'export.stageSub': (p) => `${p.label} (${p.view})…`,
    'export.stageLayout': (p) => `Mise en page (${p.view})…`,
    'export.stageWriting': 'Écriture du fichier…',
    'export.stageDone': 'Terminé',
    'export.errNoEclipse': 'Aucune éclipse sélectionnée',
    'export.errNothingExported': "Aucune vue n'a pu être exportée.",
    'export.errBadLunarSummary': "Résumé de l'éclipse lunaire invalide — export impossible.",
    'export.skippedWarning': (p) =>
        `PDF généré, mais ${p.views.length > 1 ? 'ces vues ont' : 'cette vue a'} été ignorée${p.views.length > 1 ? 's' : ''} : ${p.views.join(', ')}.`,
    'export.focusWithDuration': ' (avec durée)',
    'export.focusWithoutDuration': ' (sans durée)',
    'export.pageTitle': (p) => `${p.lunar ? 'Éclipse de Lune' : 'Éclipse'} — ${p.view}`,
    'export.subtitleSolar': (p) => `${p.type} — ${p.date} — magnitude ${p.magnitude}`,
    'export.subtitleLunar': (p) => `Lunaire ${p.type} — ${p.date} — magnitude ombrale ${p.magnitude}`,

    'error.noLunarEclipse': (p) => `Aucune éclipse lunaire autour du ${p.date}`,
};
