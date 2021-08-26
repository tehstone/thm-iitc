This script helps in finding out and tracking info about POIs in Transformers: Heavy Metal. Is is a plugin for IITC to run on https://ingress.com/intel, you need an Ingress account and IITC already installed.
The plugin is largely based on the Pokemon GO S2 plugin at [AlfonsoML/pogo-s2](https://gitlab.com/AlfonsoML/pogo-s2).

**Pre-requisites**

1. An Ingress account. You don't have to play the game, just install it once and create and account, after you have everything configured you can un-install the game if you want to.
2. Verify that you can login in https://intel.ingress.com
3a. For PC, install [Tampermonkey](https://tampermonkey.net/) on your browser of choice. Then install [IITC](https://iitc.app/)
3b. For Android install IITCm (the updated [IITC-CE](https://play.google.com/store/apps/details?id=org.exarhteam.iitc_mobile))
3c. For iOS install IITC-Mobile
4. Load again https://intel.ingress.com (or open the mobile app) and check that it works. You can enable the Google Satellite view to switch to a map easier to understand. You can also install and enable the "OpenStreetMap.org map tiles" plugin.

**Install**
[Click on this link](https://github.com/tehstone/thm-iitc/raw/main/iitcthm.user.js). If your browser prompts you to Install it confirm and then reload the Ingress Intel page. If you're on mobile you might be prompted to save it. In Android open IITCm go to settings, plugins and add a new one by picking the file that you have saved. In iOS you can install it by pasting the url after clicking the add plugin and then you have to enable it.

**Features**
In IITC there are two links added to the side pane, one shows the actions available with the THM data and the other allows you to change the settings of the plugin.

Settings dialog:
1. Draw an overlay of S2 cells (usually 16)
2. Ability to check for updated data and suggest the addition of new POIs when new Portals are detected, as well as movements or removals or portals. "Analyze portal data" setting
3. Disable most of the features of Intel that aren't relevant to THM (fields, links, portal ownership, chat...) with the "This is THM!" setting
4. Configurable colors

Actions dialog
1. Export all the THM POI data in JSON.
2. Export the THM POI data as CSV to use it in any place where they expect that format (Overpass turbo, etc)
3. Reset all the data. In case something goes wrong (maybe incompatibility with another plugin) test by clicking this option and reloading intel. If you have other IITC plugins for THM you should try to disable them if there are problems, this plugin includes everything that is needed.
4. Import/Export the whole data for backups or to use in another device

**Adding POIs**
When you select a portal, in the sidebar there will be two little icons of a raid and a signal post so you can mark this portal as a THM POI.

**Analyze portal data**
If this setting is enabled, the plugin will try detect changes in the existing portals and so it will show some messages ("Review required X", "Moved portals X", ...) and clicking on those numbers will display a dialog trying to explain the detected changes. Hovering on the photos or locations will display a blinking marker on the map, clicking on them will center the map on them (and they might end up below the dialog, so move it afterwards to check the location)
