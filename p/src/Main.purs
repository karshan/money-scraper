module Main where

import Prelude

import Data.Maybe (Maybe (..))
import Effect (Effect)
import Effect.Class (liftEffect)
import QuickServe (JSON(..), POST, RequestBody(..), quickServe)

import Scrapers.Chase as Chase
import Types (BofaRequest(..), ChaseRequest(..))

chase :: RequestBody (JSON ChaseRequest) -> POST (JSON Unit)
chase (RequestBody (JSON (ChaseRequest { webhookURL, creds }))) = do
  liftEffect $ Chase.scrape creds
  pure $ JSON unit

bofa :: RequestBody (JSON BofaRequest) -> POST (JSON Unit)
bofa (RequestBody (JSON (BofaRequest { webhookURL, creds }))) = pure $ JSON unit

main :: Effect Unit
main =
  let opts = { hostname: "localhost", port: 3200, backlog: Nothing }
  in quickServe opts { chase, bofa }
