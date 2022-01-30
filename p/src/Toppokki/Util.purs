module Toppokki.Util where

import Prelude
import Toppokki
import Util (par, timeout)

import Data.Foldable (intercalate)
import Data.Either (Either(..))
import Data.String.Regex (Regex, test)
import Effect (Effect)
import Effect.Aff (Aff, Milliseconds(..), effectCanceler, makeAff)

renderCookies :: Array Cookie -> String
renderCookies = intercalate "; " <<< map (\c -> c.name <> "=" <> c.value)

waitForResponse :: (Response -> Effect Boolean) -> Page -> Aff Unit
waitForResponse predicate page =
  timeout (Milliseconds 15000.0)
    (makeAff \cb -> do
      r <- responseListenerRec
              (\r response -> do
                  p <- predicate response
                  if p then do
                    removeResponseListener r page
                    cb (Right unit)
                    else
                      pure unit)
      addResponseListener r page
      pure $ effectCanceler (removeResponseListener r page))

waitForUrlRegex :: Regex -> Page -> Aff Unit
waitForUrlRegex urlRegex page =
  waitForResponse (\r -> test urlRegex <$> (reqUrl <=< request) r) page

frameWaitAndClick :: Selector -> Frame -> Aff Unit
frameWaitAndClick s frame = do
  e <- frameWaitForSelector s { visible: true } frame
  clickElement e

-- TODO remove waitForNavigation from Toppoki
-- replace with waitForNavAfter
waitForNavAfter :: Aff Unit -> Page -> Aff Unit
waitForNavAfter f page =
  par f (waitForNavigation {} page)
